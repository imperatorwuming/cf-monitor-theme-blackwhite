import { nodeIdentity, nodeMetadata, rememberDashboard, rememberInstance, requestFailure, resolveNode, socketTimeout } from "@/services/api";
import { apiOrigins, browserToken, cfRequest, getCfConfig } from "@/services/cfTransport";
import { object, realtimePoint, timeMs, type Row } from "@/services/cfMetrics";
import type { NodeInfo } from "@/types/komari";
import type { RealtimeDelta } from "@/types/monitor";

const POLL_MS = 30_000;
const MAX_IDS = 500;
const VALID_ID = /^[\w.:-]{1,64}$/;

export const currentNode = () => {
  const encoded = /^#\/?(?:server|instance)\/([^/?]+)/.exec(location.hash)?.[1];
  try { return encoded ? decodeURIComponent(encoded) : ""; } catch { return ""; }
};

type Source = {
  origin: string;
  source: number;
  rows: Map<string, Row>;
  settings: Row;
  timeout: number;
};

async function loadSource(origin: string, source: number, id: string, signal: AbortSignal): Promise<Source> {
  const rows = new Map<string, Row>();
  const config = await getCfConfig(origin);
  const result = { origin, source, rows, settings: {}, timeout: socketTimeout(config) };
  if (!config.is_public && !config.authorization) return result;
  try {
    const query = id ? "?" + new URLSearchParams({ id }) : "";
    const data = await cfRequest<Row>(id ? "/api/server" + query : "/api/servers", { signal }, origin);
    const servers = id ? [data] : data.servers;
    if (!Array.isArray(servers)) throw new Error("服务器列表格式无效");
    for (const row of servers.map(object)) {
      if (typeof row.id === "string" && row.id && (!id || row.id === id)) rows.set(row.id, row);
    }
    result.settings = object(data.sysConfig);
    for (const update of Array.isArray(data.latestReportUpdates) ? data.latestReportUpdates : []) {
      mergeUpdate(rows, object(update), false);
    }
  } catch (error) {
    if (!requestFailure(error, 404) || !id) throw error;
  }
  return result;
}

export async function loadNodeDirectory(signal: AbortSignal) {
  const sources = await Promise.all(apiOrigins().map((origin, source) => loadSource(origin, source, "", signal)));
  return sources.flatMap(item => [...item.rows.values()].map(row => nodeMetadata(item.source, row, item.settings)));
}

function mergeUpdate(rows: Map<string, Row>, update: Row, acceptEqual: boolean) {
  if (typeof update.serverId !== "string") return undefined;
  const row = rows.get(update.serverId);
  if (!row || !Array.isArray(update.samples)) return undefined;
  const samples = update.samples.map(object).map(sample => ({
    ts: timeMs(sample.ts ?? sample.timestamp),
    fields: object(sample.data ?? sample.payload ?? sample.metrics),
  })).sort((a, b) => a.ts - b.ts);
  let merged = row;
  for (const { ts, fields } of samples) {
    const last = timeMs(merged.last_updated);
    if (!ts || ts < last || (!acceptEqual && ts === last) || !Object.keys(fields).length) continue;
    const { id, is_hidden, timestamp, ...metrics } = fields;
    void id; void is_hidden; void timestamp;
    merged = { ...merged, ...metrics, last_updated: ts };
  }
  if (merged !== row) {
    rows.set(update.serverId, merged);
    return merged;
  }
}

type Socket = { ws: WebSocket; timeout?: number };
type Runtime = {
  snapshot: (nodes: NodeInfo[], delta: RealtimeDelta, detail: string) => void;
  update: (delta: RealtimeDelta) => void;
  failed: () => void;
  paused: (value: boolean) => void;
};

export function startMonitor(runtime: Runtime) {
  let scope: string | undefined;
  let sequence = 0;
  let sources = new Map<number, Source>();
  let fetchAbort: AbortController | undefined;
  let timer: number | undefined;
  let disposed = false;
  let paused = false;
  const sockets = new Map<string, Socket>();

  function disconnect() {
    for (const { ws, timeout } of sockets.values()) {
      window.clearTimeout(timeout);
      ws.close();
    }
    sockets.clear();
  }

  function commitUpdates(source: Source, updates: unknown[]) {
    const reports: Record<string, unknown> = Object.create(null);
    for (const update of updates.map(object)) {
      const row = mergeUpdate(source.rows, update, true);
      if (!row) continue;
      const uuid = nodeIdentity(source.source, String(row.id));
      if (scope) rememberInstance(uuid, row);
      reports[uuid] = realtimePoint(row, uuid);
    }
    if (Object.keys(reports).length) runtime.update({ sequence: ++sequence, snapshot: false, reports });
  }

  function connect() {
    if (paused || document.hidden || disposed) return;
    const desired = new Set<string>();
    for (const source of sources.values()) {
      const ids = [...source.rows.keys()].filter(id => VALID_ID.test(id));
      for (let offset = 0; offset < ids.length; offset += MAX_IDS) {
        const group = ids.slice(offset, offset + MAX_IDS);
        const key = JSON.stringify([source.origin, scope, source.timeout, group]);
        desired.add(key);
        if (sockets.has(key)) continue;
        const url = new URL("/api/ws", source.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("subscribe", scope ? group[0] : "all");
        const token = source.origin === location.origin ? "" : browserToken(source.origin);
        if (token) url.searchParams.set("token", token);
        const ws = new WebSocket(url);
        const entry: Socket = { ws };
        sockets.set(key, entry);
        ws.addEventListener("open", () => {
          if (sockets.get(key) !== entry) return;
          if (!scope) ws.send(JSON.stringify({ type: "subscribe", scope: "all", ids: group }));
          if (source.timeout) entry.timeout = window.setTimeout(() => {
            paused = true;
            disconnect();
            runtime.paused(true);
          }, source.timeout * 60_000);
        });
        ws.addEventListener("message", event => {
          if (sockets.get(key) !== entry) return;
          try {
            const data = object(JSON.parse(event.data));
            const current = sources.get(source.source);
            if (current && data.type === "batchUpdate" && Array.isArray(data.updates)) {
              commitUpdates(current, data.updates);
            }
          } catch { /* The next snapshot reconciles unexpected messages. */ }
        });
        ws.addEventListener("close", () => {
          window.clearTimeout(entry.timeout);
          if (sockets.get(key) === entry) sockets.delete(key);
        });
      }
    }
    for (const [key, entry] of sockets) {
      if (desired.has(key)) continue;
      window.clearTimeout(entry.timeout);
      sockets.delete(key);
      entry.ws.close();
    }
  }

  async function refresh(restart = false) {
    if (disposed || document.hidden) return;
    window.clearTimeout(timer);
    fetchAbort?.abort();
    const id = currentNode();
    if (scope !== id || restart) {
      scope = id;
      disconnect();
      sources = new Map();
    }
    const controller = new AbortController();
    fetchAbort = controller;
    try {
      const resolved = id ? resolveNode(id) : undefined;
      const from = resolved ? [resolved] : apiOrigins().map((origin, source) => ({ origin, source, id: "" }));
      const results = await Promise.allSettled(from.map(item => loadSource(item.origin, item.source, item.id, controller.signal)));
      if (controller.signal.aborted) return;
      const nodes: NodeInfo[] = [];
      const reports: Record<string, unknown> = Object.create(null);
      let successes = 0;
      for (const result of results) {
        if (result.status === "rejected") continue;
        const next = result.value;
        successes++;
        const past = sources.get(next.source);
        for (const [rawId, row] of next.rows) {
          const previous = past?.rows.get(rawId);
          if (previous && timeMs(previous.last_updated) > timeMs(row.last_updated)) {
            // Keep delayed REST samples from replacing a newer realtime report.
            for (const key of Object.keys(previous)) {
              if (!(key in row) || /^(cpu|ram_|swap_|load|net_|disk|ping_|loss_|tcp_conn|udp_conn|processes|last_updated|boot_time|gpu_info)/.test(key)) {
                row[key] = previous[key];
              }
            }
          }
        }
        sources.set(next.source, next);
      }
      if (!successes) {
        if (results.every(result => result.status === "rejected" && requestFailure(result.reason, 401))) {
          sources.clear();
        } else {
          runtime.failed();
          return;
        }
      }
      for (const source of sources.values()) {
        if (!id) rememberDashboard(source.source, source.rows, source.settings);
        for (const row of source.rows.values()) {
          const node = nodeMetadata(source.source, row, source.settings);
          nodes.push(node);
          const report = realtimePoint(row, node.uuid);
          if (report) reports[node.uuid] = report;
        }
      }
      if (id) {
        const source = sources.values().next().value;
        rememberInstance(id, source?.rows.values().next().value);
      }
      runtime.snapshot(nodes, { sequence: ++sequence, snapshot: true, reports }, id);
      connect();
    } catch {
      if (!controller.signal.aborted) runtime.failed();
    } finally {
      if (!disposed && !controller.signal.aborted && !document.hidden) timer = window.setTimeout(() => void refresh(), POLL_MS);
    }
  }

  const visibility = () => {
    if (document.hidden) {
      disconnect();
      fetchAbort?.abort();
      window.clearTimeout(timer);
    } else {
      void refresh();
    }
  };
  const route = () => { if (scope !== currentNode()) void refresh(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("hashchange", route);
  void refresh();
  return {
    route,
    refresh: () => { void refresh(true); },
    resume: () => {
      paused = false;
      runtime.paused(false);
      void refresh();
    },
    stop: () => {
      disposed = true;
      disconnect();
      fetchAbort?.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("hashchange", route);
    },
  };
}
