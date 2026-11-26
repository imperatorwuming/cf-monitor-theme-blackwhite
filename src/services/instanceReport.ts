import { getAdminClients, getPingRecords, getTrafficArchive, readHistory, ApiRequestError } from "./api";
import { gpuRows, loadPoint, MIB, number, timeMs } from "./cfMetrics";
import { observatoryFetch } from "./cfTransport";
import {
  METRIC_FIELDS,
  timestamp,
  validateReportRange,
  throwIfReportAborted,
} from "@/utils/instanceReport/model";
import type {
  NetworkEvidence,
  ReportInput,
  ReportMetric,
  ReportNode,
  ReportPing,
  ReportRange,
  ReportSource,
  ReportFullResult,
} from "@/utils/instanceReport/model";
import { projectEvidence, redactReport } from "@/utils/instanceReport/privacy";
import { overlayAdminClientMeta } from "@/utils/nodeMetaOverlay";
import { projectFullResult } from "@/utils/instanceReport/fullResults";
import type {
  NodeInfo,
  NodeMetrics,
  PingRecord,
  PingTask,
} from "@/types/komari";

const INPUT_LIMIT = 128 * 1024 * 1024;
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const array = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(object) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const metricValue = (v: unknown, unit: string) =>
  unit === "°C" && typeof v === "number" && Number.isFinite(v) ? v : num(v);
const check = throwIfReportAborted;
class ReportHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}
function sourceError(id: string, name: string, error: unknown): ReportSource {
  const status = error instanceof ReportHttpError || error instanceof ApiRequestError ? error.status : 0;
  return {
    id,
    name,
    state:
      status === 401 || status === 403
        ? "forbidden"
        : status === 404 || status === 405
          ? "unavailable"
          : "failed",
    detail:
      status === 401 || status === 403
        ? "当前用户无权限读取。"
        : status === 404 || status === 405
          ? "未安装此版本的网络观测接口。"
          : "查询失败，未使用其他日期或补零替代。可重新生成报告重试。",
  };
}

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  check(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("读取报告数据超时", "TimeoutError")),
    30000,
  );
  try {
    const response = await observatoryFetch(path, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new ReportHttpError(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("响应缺少正文");
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("单次响应超过 16 MiB，请缩小范围");
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function reportNode(meta: NodeInfo, current?: NodeMetrics): ReportNode {
  const show = (v: unknown) => (v == null || v === "" ? "未知" : String(v));
  const observed = current != null && Number.isFinite(current.updatedAt) && current.updatedAt > 0;
  return {
    uuid: meta.uuid,
    name: meta.name || meta.uuid,
    memory: meta.mem_total,
    swap: meta.swap_total,
    disk: meta.disk_total,
    cores: meta.cpu_cores,
    ip: [meta.ipv4, meta.ipv6].filter(Boolean),
    trafficLimit: meta.traffic_limit,
    trafficRule: meta.traffic_limit_type,
    fields: [
      ["厂商", show(meta.provider)],
      ["地区", show(meta.region)],
      ["分组", show(meta.group)],
      ["用途", show(meta.business_role)],
      ["CPU", show(meta.cpu_name)],
      ["核心", meta.cpu_cores > 0 ? String(meta.cpu_cores) : "未知"],
      ["架构", show(meta.arch)],
      ["虚拟化", show(meta.virtualization)],
      ["系统", show(meta.os)],
      ["GPU", show(meta.gpu_name)],
      ["节点 UUID", meta.uuid],
      ["接入时间", show(meta.created_at)],
      ["元数据更新", show(meta.updated_at)],
      ["内核", show(meta.kernel_version)],
      ["Agent", show(meta.version)],
      ["标签", show(meta.tags)],
      [
        "续费配置",
        meta.price > 0
          ? `${meta.currency || "币种未知"} ${meta.price} / ${meta.billing_cycle || "周期未知"}`
          : "未配置价格",
      ],
      ["到期", show(meta.expired_at)],
      ["自动续费", meta.auto_renewal ? "已开启" : "未开启"],
      [
        "Ping 能力",
        meta.capability_ping == null
          ? "未知"
          : meta.capability_ping
            ? "已启用"
            : "未启用",
      ],
      [
        "私有目标 Ping",
        meta.capability_private_ping_targets == null
          ? "未知"
          : meta.capability_private_ping_targets
            ? "已启用"
            : "未启用",
      ],
      ["公开备注", show(meta.public_remark)],
    ],
    snapshot: {
      online: current?.online ?? null,
      uptime: observed && Number.isFinite(current.uptime) && current.uptime >= 0 ? current.uptime : null,
      updatedAt: observed ? current.updatedAt : null,
      trafficUp: observed && Number.isFinite(current.trafficUp) && current.trafficUp >= 0 ? current.trafficUp : null,
      trafficDown: observed && Number.isFinite(current.trafficDown) && current.trafficDown >= 0 ? current.trafficDown : null,
      ...(observed && current.monthlyUp != null ? { monthlyUp: current.monthlyUp } : {}),
      ...(observed && current.monthlyDown != null ? { monthlyDown: current.monthlyDown } : {}),
    },
  };
}

export function normalizeReportMetrics(
  payload: unknown,
  uuid: string,
  range: ReportRange,
): ReportMetric[] {
  const data = object(payload),
    records = Array.isArray(data.records)
      ? array(data.records)
      : array(object(data.records)[uuid]);
  if (!Array.isArray(data.records) && !(uuid in object(data.records)))
    throw new Error("历史资源响应缺少节点记录");
  return METRIC_FIELDS.map(([key, label, unit]) => ({
    key,
    label,
    unit,
    precision: (key.startsWith("net_total")
      ? "计数器末值"
      : "返回点") as ReportMetric["precision"],
    points: records
      .filter((r) => !r.client || r.client === uuid)
      .map((r) => ({ t: timestamp(r.time), v: metricValue(r[key], unit) }))
      .filter((p) => p.t >= range.start && p.t < range.end),
  })).filter((m) => m.points.some((p) => p.v != null));
}

export async function collectMetrics(
  uuid: string,
  range: ReportRange,
  signal: AbortSignal,
): Promise<{ metrics: ReportMetric[]; source: ReportSource }> {
  const [history, traffic] = await Promise.all([
    readHistory(uuid, 168, reportWindow(range), signal),
    getTrafficArchive([uuid], range.start, range.end, 1200, signal),
  ]);
  const records = history.rows.map(row => {
    const point = loadPoint(row, uuid, timeMs(row.timestamp));
    const mapped: Obj = { ...point };
    const gpu = gpuRows(row.gpu_info);
    const gpuValues = gpu.map(item => num(number(item.info, NaN))).filter((value): value is number => value != null);
    mapped.gpu = gpuValues.length ? gpuValues.reduce((sum, value) => sum + value, 0) / gpuValues.length : null;
    const fromCf = {
      cpu: "cpu", ram: "ram_used", swap: "swap_used", load: "load",
      disk: "disk_used", net_in: "net_in_speed", net_out: "net_out_speed",
      net_total_up: "net_tx", net_total_down: "net_rx", process: "processes",
      connections: "tcp_conn", connections_udp: "udp_conn", gpu: "gpu_info",
    };
    if (row.load_avg != null && row.load == null) row = { ...row, load: row.load_avg };
    for (const key of Object.keys(mapped)) {
      if (key === "client" || key === "time") continue;
      const field = fromCf[key as keyof typeof fromCf];
      if (!field || row[field] == null || row[field] === "" || (field === "gpu_info" && row[field] === "[]")) delete mapped[key];
    }
    return mapped;
  });
  const archived = (traffic[uuid] || []).map(record => ({
    client: uuid, time: record.time, net_total_up: record.net_total_up, net_total_down: record.net_total_down,
  }));
  const metrics = normalizeReportMetrics({ records }, uuid, range);
  for (const metric of normalizeReportMetrics({ records: archived }, uuid, range)) {
    if (!metrics.some(existing => existing.key === metric.key)) metrics.push(metric);
  }
  const deviceMetrics = new Map<string, ReportMetric>();
  const gpuFields = [
    { key: "gpu_device", field: "info", label: "GPU 使用率", unit: "%", size: 1 },
    { key: "gpu_memory", field: "mem_used", label: "GPU 显存使用", unit: "B", size: MIB },
    { key: "gpu_memory_total", field: "mem_total", label: "GPU 显存容量", unit: "B", size: MIB },
  ];
  for (const row of history.rows) {
    const t = timeMs(row.timestamp);
    if (t < range.start || t >= range.end) continue;
    for (const [index, gpu] of gpuRows(row.gpu_info).entries()) {
      const name = str(gpu.name);
      const device = typeof gpu.id === "string" || typeof gpu.id === "number" ? String(gpu.id) : String(index);
      for (const field of gpuFields) {
        const value = num(number(gpu[field.field], NaN));
        if (value == null) continue;
        const key = `${field.key}[${device}|${name}]`;
        if (!deviceMetrics.has(key)) deviceMetrics.set(key, {
          key, label: `${field.label} · GPU ${device}${name ? " · " + name : ""}`,
          unit: field.unit, precision: "返回点", points: [],
        });
        deviceMetrics.get(key)!.points.push({ t, v: value * field.size });
      }
    }
  }
  metrics.push(...deviceMetrics.values());
  return { metrics, source: historySource("metrics", "资源与流量历史", history.limited, metrics.length > 0, history.max) };
}

function reportWindow(range: ReportRange) {
  return { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() };
}

function historySource(id: string, name: string, limited: boolean, hasRows: boolean, max: number): ReportSource {
  return {
    id, name, state: limited ? "partial" : hasRows ? "available" : "empty",
    detail: limited
      ? `CF-Server-Monitor 当前可查询最近 ${max} 小时，所选范围超出可查询窗口。`
      : hasRows
        ? "按所选起止时间过滤 CF-Server-Monitor 返回的采样点。"
        : "所选日期没有可读取的历史。",
  };
}

export function normalizeReportPings(
  records: PingRecord[],
  tasks: PingTask[],
  range: ReportRange,
): ReportPing[] {
  const byId = new Map<number, ReportPing>();
  for (const task of tasks)
    byId.set(task.id, {
      id: task.id,
      name: task.name || `历史任务 #${task.id}`,
      protocol: task.type,
      target: task.target || "",
      interval: task.interval,
      points: [],
    });
  const dedup = new Map<string, PingRecord>();
  for (const r of records) {
    const t = timestamp(r.time);
    if (t >= range.start && t < range.end) dedup.set(`${r.task_id}:${t}`, r);
  }
  for (const r of dedup.values()) {
    const task = byId.get(r.task_id) ?? {
      id: r.task_id,
      name: `历史任务 #${r.task_id}`,
      protocol: "未知",
      target: "",
      interval: 0,
      points: [],
    };
    const count = r.sample_count == null ? 1 : (num(r.sample_count) ?? 0);
    const explicitLost =
      num(r.loss_count) ??
      (r.loss_rate != null && r.loss_rate >= 0 && r.loss_rate <= 1
        ? (r.loss_rate * count)
        : null);
    const sent = count > 0 && (count === 1 || explicitLost != null) ? count : 0;
    const lost = sent
      ? Math.min(sent, explicitLost ?? (r.value < 0 ? sent : 0))
      : 0;
    task.points.push({
      t: timestamp(r.time),
      v: sent && sent === lost ? null : num(r.value),
      sent,
      lost,
      valid: sent - lost,
    });
    byId.set(r.task_id, task);
  }
  return [...byId.values()].map((p) => ({
    ...p,
    points: p.points.sort((a, b) => a.t - b.t),
  }));
}

export async function collectPings(
  uuid: string,
  range: ReportRange,
  signal: AbortSignal,
) {
  const { records, tasks, from } = await getPingRecords(uuid, 168, reportWindow(range), signal);
  const pings = normalizeReportPings(records, tasks, range);
  const history = await readHistory(uuid, 168, reportWindow(range), signal);
  return {
    pings,
    source: historySource("ping", "Ping 历史", Number(from) > range.start, pings.some(ping => ping.points.length), history.max),
  };
}

async function networkV3(uuid: string, range: ReportRange, signal: AbortSignal) {
  const base = `/api/blackwhite-network-observatory/v3`, nodePath = `${base}/nodes/${encodeURIComponent(uuid)}`;
  const caps = object(await readJson(`${base}/capabilities`, signal));
  if (!Array.isArray(caps.modules) || caps.schema !== 3) throw new Error("网络报告能力响应无效");
  const evidence: NetworkEvidence[] = [], fullResults: ReportFullResult[] = [], warnings: string[] = [];
  const targetRefs = new Map<string, string>();
  const targetCounts = new Map<string, number>();
  const targetRef = (module: string, source: Obj, target: unknown, family: string, direction: unknown, protocol: unknown) => {
    const key = JSON.stringify([module, source.id || target || "", family, direction, protocol]);
    if (!targetRefs.has(key)) { const count = (targetCounts.get(module) || 0) + 1; targetCounts.set(module, count); targetRefs.set(key, `测点 ${count}`); }
    return targetRefs.get(key)!;
  };
  let partial = false, bytes = 0, unavailableRounds = 0, summaryApi: boolean | undefined;
  const append = (entry: NetworkEvidence) => {
    bytes += JSON.stringify(entry).length * 2;
    evidence.push(entry);
  };
  for (const module of caps.modules.filter((m): m is string => typeof m === "string")) {
    try {
      let cursor = "", pages = 0;
      const seen = new Set<string>();
      do {
        check(signal);
        if (seen.has(cursor) || pages++ >= 10000) { partial = true; warnings.push(`${module} 分页未正常结束。`); break; }
        seen.add(cursor);
        const suffix = `?module=${encodeURIComponent(module)}&limit=20&cursor=${encodeURIComponent(cursor)}`;
        let page: Obj;
        if (summaryApi !== false) {
          try { page = object(await readJson(`${nodePath}/history-summary${suffix}`, signal)); summaryApi = true; }
          catch (error) {
            if (!(error instanceof ReportHttpError) || ![404, 405].includes(error.status)) throw error;
            summaryApi = false;
            page = object(await readJson(`${nodePath}/rounds${suffix}`, signal));
          }
        } else page = object(await readJson(`${nodePath}/rounds${suffix}`, signal));
        if (!Array.isArray(page.rounds)) throw new Error("网络轮次分页响应无效");
        for (const round of array(page.rounds)) {
          const start = timestamp(round.startedAt || round.plannedAt || round.completedAt), end = timestamp(round.completedAt);
          if (!(start < range.end) || (Number.isFinite(end) && end < range.start)) continue;
          if (evidence.length >= 100000 || bytes > INPUT_LIMIT / 2) { partial = true; break; }
          let expired = round.detailAvailable === false;
          let full: Obj;
          try {
            if (expired && Array.isArray(round.slots)) full = round;
            else full = object(await readJson(`${nodePath}/rounds/${encodeURIComponent(str(round.id))}`, signal));
            expired = expired || full.detailAvailable === false;
            if (!Array.isArray(full.slots) || (!expired && !Array.isArray(full.measurements))) throw new Error("网络轮次明细响应无效");
          } catch (error) {
            check(signal); partial = true; unavailableRounds++;
            if (Number.isFinite(end) && end >= range.start && end < range.end)
              append({ id: `v3:${str(round.id)}`, module, time: end, state: str(round.state), target: "", direction: "", source: "轮次明细不可用", summaryOnly: true,
                family: str(round.family), detail: projectEvidence({ counts: round.counts, detailAvailable: false }) });
            continue;
          }
          const measurements = array(full.measurements), matched = new Set(measurements.map(m => str(m.slotId)));
          const family = str(object(full.parameters).family) || str(round.family);
          for (const measurement of measurements) {
            if (measurement.nodeUuid && measurement.nodeUuid !== uuid) { partial = true; continue; }
            const t = timestamp(measurement.completedAt), started = timestamp(measurement.startedAt);
            if (!Number.isFinite(t) || t < range.start || t >= range.end) continue;
            const source = object(measurement.source), options = object(measurement.options);
            const snapshot = projectFullResult(module, str(round.id), measurement);
            if (snapshot) {
              const size = JSON.stringify(snapshot).length * 2;
              if (bytes + size <= INPUT_LIMIT / 2) { fullResults.push(snapshot); bytes += size; }
              else { partial = true; warnings.push("完整检测原始结果超过报告容量，部分结果未纳入。"); }
            }
            append({ id: `v3:${str(round.id)}:${str(measurement.id)}`, module, time: t,
              startedAt: Number.isFinite(started) ? started : undefined, state: str(object(measurement.data).state),
              target: str(measurement.target), direction: str(measurement.direction),
              source: [source.provider, source.name, source.city, source.carrier].filter(v => typeof v === "string").join(" · "),
              family: str(options.family) || family, city: str(source.city), carrier: str(source.carrier),
              provider: str(source.provider), protocol: str(options.protocol), targetRef: targetRef(module, source, measurement.target, str(options.family) || family, measurement.direction, options.protocol),
              detail: projectEvidence({ ...object(measurement.data), protocol: options.protocol, family: str(options.family) || family }) });
          }
          if (expired) partial = true;
          for (const slot of array(full.slots)) {
            if (matched.has(str(slot.id))) continue;
            const slotTime = timestamp(slot.completedAt), t = Number.isFinite(slotTime) ? slotTime : end;
            if (!Number.isFinite(t) || t < range.start || t >= range.end) continue;
            const source = object(slot.source), options = object(slot.options), saved = object(slot.metrics);
            append({ id: `v3:${str(round.id)}:slot:${str(slot.id)}`, module, time: t,
              state: str(slot.state), target: str(slot.target), direction: str(slot.direction),
              source: [source.provider, source.name, source.city, source.carrier].filter(v => typeof v === "string").join(" · ") || "未完成的检测项",
              family, city: str(source.city), carrier: str(source.carrier), provider: str(source.provider), protocol: str(options.protocol), targetRef: targetRef(module, source, slot.target, family, slot.direction, options.protocol),
              summaryOnly: expired, detail: projectEvidence({ ...saved, state: slot.state, family, protocol: options.protocol, detailAvailable: !expired }) });
          }
          if (expired && !array(full.slots).length && Number.isFinite(end) && end >= range.start && end < range.end)
            append({ id: `v3:${str(round.id)}`, module, time: end, state: str(round.state), target: "", direction: "", source: "网络报告 v3", summaryOnly: true,
              family, detail: projectEvidence({ counts: round.counts, detailAvailable: false }) });
        }
        cursor = str(page.nextCursor);
        if (evidence.length >= 100000 || bytes > INPUT_LIMIT / 2) { partial = true; warnings.push("网络观测超过单份报告预算，已保留先读取的记录。"); break; }
      } while (cursor);
    } catch (error) {
      check(signal); partial = true;
      warnings.push(`${module} 查询失败${error instanceof ReportHttpError ? `（HTTP ${error.status}）` : ""}，其余模块已保留。`);
    }
  }
  if (unavailableRounds) warnings.push(`${unavailableRounds} 个轮次明细不可用，保留可读取的轮次摘要。`);
  const retention = object(caps.retention);
  return { evidence, fullResults, source: { id: "network-v3", name: "网络报告 v3", state: partial ? "partial" : evidence.length ? "available" : "empty",
    detail: `只汇总既有测量；明细保留 ${num(retention.detailDays) ?? "未知"} 天，摘要 ${num(retention.summaryDays) ?? "未知"} 天。${partial ? "存在明细过期、查询失败或预算限制，不能保证全部证据完整。" : "已完成所有模块分页。"}${warnings.join(" ")}` } satisfies ReportSource };
}

export interface ReportRequest {
  resultStyle?: "unified" | "original";
  meta: NodeInfo;
  current?: NodeMetrics;
  range: ReportRange;
  theme: "light" | "dark";
  showAddresses: boolean;
  compare: boolean;
  loggedIn: boolean;
}
export async function collectReportInput(
  request: ReportRequest,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<ReportInput> {
  const now = Date.now();
  validateReportRange(request.range, now);
  check(signal);
  const range = { ...request.range },
    sources: ReportSource[] = [];
  let meta = { ...request.meta },
    metrics: ReportMetric[] = [],
    pings: ReportPing[] = [],
    network: NetworkEvidence[] = [],
    fullResults: ReportFullResult[] = [],
    backend = "CF-Server-Monitor";
  progress("正在读取节点资料…");
  if (request.loggedIn) {
    try {
      const client = (await getAdminClients()).find(candidate => candidate.uuid === meta.uuid);
      if (!client) throw new Error("管理端节点资料不可用");
      meta = overlayAdminClientMeta(meta, client);
    } catch (error) {
      check(signal);
      sources.push({
        ...sourceError("admin-meta", "管理端补充资料", error),
        detail: "管理端补充资料不可用，沿用当前已授权的节点元数据。",
      });
    }
  }
  const node = reportNode(meta, request.current);
  // Three independent collectors at a time; network GETs are sequential and bounded.
  await Promise.all([
    (async () => {
      try {
        const r = await collectMetrics(meta.uuid, range, signal);
        metrics = r.metrics;
        sources.push(r.source);
      } catch (e) {
        check(signal);
        sources.push(sourceError("metrics", "资源与流量历史", e));
      }
      progress("资源与流量收集完成，正在整理其他数据…");
    })(),
    (async () => {
      try {
        const r = await collectPings(meta.uuid, range, signal);
        pings = r.pings;
        sources.push(r.source);
      } catch (e) {
        check(signal);
        sources.push(sourceError("ping", "Ping 历史", e));
      }
    })(),
    (async () => {
      progress("正在读取网络观测的既有轮次…");
      try {
        const r = await networkV3(meta.uuid, range, signal);
        network.push(...r.evidence); fullResults = r.fullResults; sources.push(r.source);
      } catch (e) {
        check(signal); sources.push(sourceError("network-v3", "网络观测", e));
      }
    })(),
  ]);
  check(signal);
  if (range.allHistory) {
    let earliest = range.end;
    for (const metric of metrics) for (const point of metric.points) if (point.v != null && Number.isFinite(point.t)) earliest = Math.min(earliest, point.t);
    for (const ping of pings) for (const point of ping.points) if (point.sent > 0 && Number.isFinite(point.t)) earliest = Math.min(earliest, point.t);
    for (const item of network) if (Number.isFinite(item.time)) earliest = Math.min(earliest, item.time);
    if (earliest < range.end) {
      range.start = Math.max(0, Math.floor(earliest / 86400000) * 86400000 - 86400000);
    }
    sources.push({ id: "all-history", name: "全部历史范围", state: "available", detail: "已从 1970 年起查询；图表从最早可读取数据附近开始。已过期、被删除或无权限的数据无法恢复。" });
  }
  const reportId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `rpt-${now.toString(36)}-${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const input: ReportInput = {
    schemaVersion: 1,
    reportId,
    generatedAt: now,
    range,
    theme: request.theme,
    showAddresses: request.showAddresses,
    backend,
    resultStyle: request.resultStyle === "original" ? "original" : "unified",
    fullResults: [...new Map(fullResults.map(result => [result.id, result])).values()].sort((a, b) => b.time - a.time),
    node,
    sources,
    metrics,
    pings,
    network: [...new Map(network.map((n) => [n.id, n])).values()].sort(
      (a, b) => b.time - a.time,
    ),
  };
  if (request.compare) {
    progress("正在读取前一等长区间…");
    const previousRange = {
      ...range,
      end: range.start,
      start: range.start - (range.end - range.start),
    };
    const [m, p] = await Promise.allSettled([
      collectMetrics(meta.uuid, previousRange, signal),
      collectPings(meta.uuid, previousRange, signal),
    ]);
    check(signal);
    input.previous = {
      range: previousRange,
      metrics: m.status === "fulfilled" ? m.value.metrics : [],
      pings: p.status === "fulfilled" ? p.value.pings : [],
      sources: [
        m.status === "fulfilled"
          ? m.value.source
          : sourceError("metrics", "上一期间资源", m.reason),
        p.status === "fulfilled"
          ? p.value.source
          : sourceError("ping", "上一期间 Ping", p.reason),
      ],
    };
  }
  const size = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (size > INPUT_LIMIT)
    throw new Error("报告输入超过 128 MiB，请缩小日期范围后重试。");
  progress("正在计算统计、数据覆盖与报告结论…");
  return redactReport(input);
}
