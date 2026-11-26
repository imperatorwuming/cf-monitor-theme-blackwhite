import {
  adminClient, dashboardPingRows, HOUR, loadPoint, nodeInfo, number, object,
  pingPoints, pingTasks, timeMs, type Row,
} from "@/services/cfMetrics";
import { apiOrigins, ApiRequestError, cfRequest, getCfConfig, observatoryFetch, type CfConfig } from "@/services/cfTransport";
import type { PingOverviewResult } from "@/types/monitor";
import type { LoadRecord, NodeInfo, PingRecord, PingRecordsResponse, PingTask, PublicConfig } from "@/types/komari";

export { ApiRequestError };

export type ComparisonLoadType =
  | "all" | "traffic" | "cpu" | "ram" | "swap" | "load" | "disk"
  | "network" | "process" | "connections";
export type ComparisonLoadRecords = Record<string, LoadRecord[]>;
export type ComparisonTimeRange = { start: string | number | null; end: string | number | null };

const dashboard = new Map<number, { servers: Map<string, Row>; settings: Row }>();
let instancePing: { uuid: string; row: Row } | undefined;
const HISTORY_WINDOWS = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168];
const THEME_KEY = "blackwhite";

export function nodeIdentity(source: number, id: string) {
  return source === 0 ? id : `s${source}:${id}`;
}

export function resolveNode(uuid: string) {
  const match = /^s(\d+):(.+)$/.exec(uuid);
  const source = match ? Number(match[1]) : 0;
  const id = match?.[2] ?? uuid;
  const origin = apiOrigins()[source];
  if (!origin || !id) throw new Error("未知服务器");
  return { origin, source, id };
}

function rowsOf(value: unknown) {
  if (!Array.isArray(value)) throw new Error("CF-Server-Monitor 数据格式无效");
  return value.map(object);
}

export function rememberDashboard(source: number, servers: Map<string, Row>, settings: Row) {
  dashboard.set(source, { servers, settings });
}

export function rememberInstance(uuid: string, row?: Row) {
  instancePing = row ? { uuid, row } : undefined;
}

export async function getMe() {
  const config = await getCfConfig();
  return { logged_in: config.authorization, username: config.authorization ? "管理员" : "", uuid: "" };
}

export async function getPublic(): Promise<PublicConfig> {
  const config = await getCfConfig();
  const history = config.authorization ? 168 : 24;
  const settings = object(config.theme_options?.[THEME_KEY]);
  const preset = config.preferred_theme === "dark" ? "crystal-dark" : "crystal-light";
  return {
    sitename: config.site_title || (typeof document === "undefined" ? "" : document.title),
    description: "",
    theme: THEME_KEY,
    allow_cors: false,
    disable_password_login: false,
    oauth_enable: false,
    private_site: !config.is_public,
    record_enabled: true,
    record_preserve_time: history,
    ping_record_preserve_time: history,
    custom_head: "",
    custom_body: "",
    theme_settings: { defaultAppearance: preset, ...settings },
    version: config.version,
  };
}

export async function saveThemeSettings(theme: string, settings: Row) {
  const config = await getCfConfig(apiOrigins()[0], true);
  await cfRequest("/api/theme_options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme_options: { ...object(config.theme_options), [theme]: settings } }),
  });
  await getCfConfig(apiOrigins()[0], true);
}

let adminCache: { expiry: number; task: ReturnType<typeof loadAdminDirectory> } | undefined;
let adminAuthorized = false;
async function loadAdminDirectory() {
  const result = await cfRequest<{ servers: unknown }>("/admin/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list" }),
  });
  return rowsOf(result.servers);
}

export function clearMonitorCaches() {
  adminAuthorized = false;
  adminCache = undefined;
  dashboard.clear();
  instancePing = undefined;
  historyCache.clear();
}

async function adminDirectory() {
  if (!adminAuthorized) {
    adminAuthorized = (await getCfConfig()).authorization;
  }
  if (!adminAuthorized) throw new ApiRequestError("请先登录 CF-Server-Monitor 后台", 401, "/admin/api");
  if (adminCache && Date.now() < adminCache.expiry) return adminCache.task;
  const task = loadAdminDirectory().catch(error => {
    if (adminCache?.task === task) adminCache = undefined;
    throw error;
  });
  adminCache = { expiry: Date.now() + 30_000, task };
  return task;
}

export async function getAdminClients() {
  return (await adminDirectory()).filter(row => typeof row.id === "string").map(row => adminClient(row, String(row.id)));
}

function mergeTasks(tasks: PingTask[]) {
  const byId = new Map<number, PingTask>();
  for (const task of tasks) {
    const saved = byId.get(task.id);
    if (!saved) byId.set(task.id, { ...task, clients: [...task.clients] });
    else {
      for (const client of task.clients) if (!saved.clients.includes(client)) saved.clients.push(client);
      if (saved.target !== task.target) saved.target = "";
      saved.interval = Math.min(saved.interval, task.interval);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export async function getAdminPingTasks() {
  const origin = apiOrigins()[0];
  const [config, rows, settings] = await Promise.all([
    getCfConfig(origin), adminDirectory(),
    cfRequest<Row>("/admin/api", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get_settings" }),
    }),
  ]);
  return mergeTasks(rows.flatMap(row => pingTasks(config, 0, String(row.id), row, { ...object(settings.settings), ...row })));
}

const historyCache = new Map<string, { expiry: number; task: Promise<Row[]> }>();

export function resolveHistoryWindow(hours: number, range: ComparisonTimeRange | undefined, config: CfConfig, now = Date.now()) {
  const max = config.authorization ? 168 : 24;
  const requestedStart = range?.start != null ? timeMs(range.start) : now - Math.max(0.167, hours) * HOUR;
  const requestedEnd = range?.end != null ? timeMs(range.end) : now;
  if (!(requestedEnd > requestedStart)) throw new Error("历史时间范围无效");
  const from = Math.max(requestedStart, now - max * HOUR);
  const to = Math.min(requestedEnd, now);
  const ageHours = (now - from) / HOUR;
  const window = HISTORY_WINDOWS.find(value => value >= ageHours) ?? max;
  return { from, to, window, limited: requestedStart < from, max };
}

function waitForRead<T>(task: Promise<T>, signal?: AbortSignal) {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readHistory(uuid: string, hours: number, range?: ComparisonTimeRange, signal?: AbortSignal) {
  const { origin, source, id } = resolveNode(uuid);
  signal?.throwIfAborted();
  const config = await getCfConfig(origin);
  signal?.throwIfAborted();
  const window = resolveHistoryWindow(hours, range, config);
  if (window.to <= window.from) return { ...window, config, source, rows: [] };
  const key = `${origin}/${id}:${window.window}:${config.authorization}`;
  let cached = historyCache.get(key);
  if (!cached || Date.now() >= cached.expiry) {
    if (historyCache.size >= 256) historyCache.delete(historyCache.keys().next().value!);
    const query = new URLSearchParams({ id, hours: String(window.window) });
    const task = cfRequest<unknown>("/api/history/all?" + query, {}, origin).then(rowsOf).catch(error => {
      if (historyCache.get(key)?.task === task) historyCache.delete(key);
      if (error instanceof ApiRequestError && error.status === 409 && error.message === "historyPartitionNotAssigned") return [];
      throw error;
    });
    cached = { task, expiry: Date.now() + 45_000 };
    historyCache.set(key, cached);
  }
  const rows = (await waitForRead(cached.task, signal))
    .filter(row => {
      const time = timeMs(row.timestamp);
      return time >= window.from && time <= window.to;
    })
    .sort((left, right) => timeMs(left.timestamp) - timeMs(right.timestamp));
  return { ...window, config, source, rows };
}

export const getComparisonRecordsMaxCount = (hours: number, perHour = 12) =>
  Math.min(5000, Math.max(1, Math.ceil(hours * perHour)));

function spreadPoints<T>(points: T[], max: number) {
  if (points.length <= max) return points;
  if (max <= 1) return points.slice(-1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
}

export async function getLoadRecords(uuid: string, hours = 6, _node?: NodeInfo, range?: ComparisonTimeRange) {
  const history = await readHistory(uuid, hours, range);
  const records = history.rows.map(row => loadPoint(row, uuid));
  return { count: records.length, records };
}

async function mapFleet<T>(uuids: string[], mapper: (uuid: string) => Promise<T>) {
  const ids = [...new Set(uuids.filter(Boolean))];
  const out: Array<readonly [string, T]> = [];
  for (let cursor = 0; cursor < ids.length; cursor += 6) {
    out.push(...await Promise.all(ids.slice(cursor, cursor + 6).map(async uuid => [uuid, await mapper(uuid)] as const)));
  }
  return out;
}

export async function getComparisonLoadRecords({
  uuids, hours = 6, range, maxPoints, loadType,
}: {
  uuids: string[];
  hours?: number;
  loadType: ComparisonLoadType;
  nodes?: NodeInfo[];
  range?: ComparisonTimeRange;
  maxPoints?: number;
}): Promise<ComparisonLoadRecords> {
  if (loadType === "traffic") {
    const to = range?.end == null ? Date.now() : timeMs(range.end);
    const from = range?.start == null ? to - hours * HOUR : timeMs(range.start);
    if (to <= from) return {};
    return getTrafficArchive(uuids, from, to, maxPoints);
  }
  return Object.fromEntries(await mapFleet(uuids, async uuid => {
    const { records } = await getLoadRecords(uuid, hours, undefined, range);
    return maxPoints == null ? records : spreadPoints(records, Math.max(1, Math.trunc(maxPoints)));
  }));
}

export async function getPingRecords(uuid: string, hours = 6, range?: ComparisonTimeRange, signal?: AbortSignal): Promise<PingRecordsResponse> {
  const history = await readHistory(uuid, hours, range, signal);
  const { id } = resolveNode(uuid);
  const records = history.rows.flatMap(row => pingPoints(row, uuid, history.source, timeMs(row.timestamp)));
  const seen = new Set(records.map(row => row.task_id));
  const node = dashboard.get(history.source)?.servers.get(id);
  const tasks = pingTasks(history.config, history.source, uuid, node).filter(task => seen.has(task.id));
  // A disabled probe can still have historical samples from before it was disabled.
  const taskIds = new Set(tasks.map(task => task.id));
  tasks.push(...pingTasks(history.config, history.source, uuid).filter(task => seen.has(task.id) && !taskIds.has(task.id)));
  return { count: records.length, records, tasks, from: history.from, to: history.to };
}

export async function getComparisonPingRecords({ uuids, hours = 6, range }: {
  uuids: string[]; hours?: number; range?: ComparisonTimeRange;
}): Promise<PingRecordsResponse> {
  const data = (await mapFleet(uuids, uuid => getPingRecords(uuid, hours, range))).map(([, result]) => result);
  const records = data.flatMap(result => result.records).sort((a, b) => Number(a.time) - Number(b.time));
  return { count: records.length, records, tasks: mergeTasks(data.flatMap(result => result.tasks)) };
}

export async function getPingOverviewForNodes(uuids: string[], options?: { signal?: AbortSignal }): Promise<PingOverviewResult> {
  const to = Date.now(), from = to - HOUR;
  const stats: PingOverviewResult["stats"] = {};
  const series: PingOverviewResult["series"] = {};
  const tasks: PingTask[] = [];
  const resolved = uuids.map(uuid => ({ uuid, ...resolveNode(uuid) }));
  const origins = [...new Set(resolved.map(node => node.origin))];
  const configs = await Promise.all(origins.map(origin => getCfConfig(origin)));
  for (const { uuid, source, id, origin } of resolved) {
    options?.signal?.throwIfAborted();
    const saved = dashboard.get(source);
    const row = instancePing?.uuid === uuid ? instancePing.row : saved?.servers.get(id);
    if (!row || (instancePing?.uuid !== uuid && saved?.settings.show_three_net_details === false)) continue;
    const recordsById = new Map<number, PingRecord[]>();
    for (const bucket of dashboardPingRows(row)) {
      const timestamp = timeMs(bucket.timestamp);
      if (timestamp < from || timestamp > to) continue;
      for (const record of pingPoints(bucket, uuid, source, timestamp)) {
        const records = recordsById.get(record.task_id) ?? [];
        records.push(record);
        recordsById.set(record.task_id, records);
      }
    }
    // The current snapshot also supplies custom nodes when the dashboard's
    // history window does not contain those lines.
    const seen = timeMs(row.last_updated);
    if (seen >= from && seen <= to) {
      for (const record of pingPoints(row, uuid, source, seen)) {
        const records = recordsById.get(record.task_id) ?? [];
        if (!records.some(point => point.time === seen)) records.push(record);
        recordsById.set(record.task_id, records);
      }
    }
    stats[uuid] = {};
    series[uuid] = {};
    const available = pingTasks(configs[origins.indexOf(origin)], source, uuid, row);
    for (const task of available) {
      const points = (recordsById.get(task.id) ?? []).sort((a, b) => Number(a.time) - Number(b.time));
      if (!points.length) continue;
      tasks.push(task);
      const latencies = points.map(point => point.value).filter(value => value > 0);
      const lost = points.reduce((sum, point) => sum + (point.loss_count ?? 0), 0);
      const loss = points.length ? lost / points.length * 100 : 0;
      series[uuid][task.id] = points.map(point => ({
        time: point.time, value: point.value, sample_count: 1,
        loss_count: point.loss_count ?? 0, loss: (point.loss_rate ?? 0) * 100,
      }));
      if (points.length) stats[uuid][task.id] = {
        name: task.name, total: points.length, lost, loss, latest: latencies.at(-1) ?? -1,
        min: latencies.length ? Math.min(...latencies) : 0,
        max: latencies.length ? Math.max(...latencies) : 0,
        avg: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
        tail: 0,
      };
    }
  }
  return { from, to, stats, series, tasks: mergeTasks(tasks) };
}

export function nodeMetadata(source: number, row: Row, settings: Row) {
  return nodeInfo(row, nodeIdentity(source, String(row.id)), settings);
}

export function requestFailure(error: unknown, code: number) {
  return error instanceof ApiRequestError && error.status === code;
}

export function socketTimeout(config: CfConfig) {
  return Math.max(0, number(config.frontend_ws_timeout_minutes));
}

export async function getTrafficArchive(uuids: string[], start: number, end: number, requestedPoints = 720, signal?: AbortSignal) {
  const primaryIds = [...new Set(uuids.filter(uuid => resolveNode(uuid).source === 0))];
  const points = Math.max(2, Math.min(2_000, Math.trunc(requestedPoints)));
  const batches = Array.from({ length: Math.ceil(primaryIds.length / 64) }, (_, index) => primaryIds.slice(index * 64, (index + 1) * 64));
  const builds = await Promise.all(batches.map(async ids => {
    try {
      const response = await observatoryFetch("/api/blackwhite-network-observatory/v3/traffic-history", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, start: Math.trunc(start), end: Math.trunc(end), points }),
      }, 12_000, signal);
      if (!response.ok || !response.headers.get("content-type")?.includes("json")) return {};
      return object(await response.json());
    } catch {
      signal?.throwIfAborted();
      return {};
    }
  }));
  const archived = Object.assign({}, ...builds);
  return Object.fromEntries(primaryIds.map(uuid => [
    uuid, Array.isArray(archived[uuid]) ? archived[uuid].map(object).map((row: Row) => loadPoint(row, uuid)) : [],
  ])) as ComparisonLoadRecords;
}
