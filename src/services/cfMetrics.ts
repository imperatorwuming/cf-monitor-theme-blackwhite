import { NodeInfoSchema, AdminClientSchema, type LoadRecord, type PingRecord, type PingTask } from "@/types/komari";

export type Row = Record<string, unknown>;
export const MIB = 1024 ** 2;
export const HOUR = 3_600_000;
export const ONLINE_WINDOW = 300_000;

export const number = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
export const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";
const string = (value: unknown) => typeof value === "string" ? value : "";

export function timeMs(value: unknown): number {
  const numeric = number(value, NaN);
  if (numeric > 0) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

const BILLING_LABELS = ["month", "quarter", "half_year", "year", "two_years", "three_years", "four_years", "five_years"];
const BILLING_DAYS = [30, 90, 180, 365, 730, 1095, 1460, 1825];

function quotaBytes(value: unknown) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?(?:i?b)?)\s*$/i.exec(String(value ?? ""));
  if (!match) return 0;
  const i = ["", "k", "m", "g", "t", "p"].indexOf(match[2].toLowerCase().replace(/i?b$/, ""));
  return number(match[1]) * 1024 ** (match[2] ? i : 3);
}

export function gpuRows(value: unknown) {
  try {
    const rows = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(rows)) return rows.map(object);
  } catch { /* Older agents can send an empty value. */ }
  return [];
}

export function nodeInfo(row: Row, uuid: string, settings: Row = {}, admin = false) {
  const price = number(row.price, NaN);
  const billing = BILLING_LABELS.indexOf(string(row.billing_cycle));
  return NodeInfoSchema.parse({
    uuid,
    name: string(row.name) || uuid,
    group: row.server_group,
    region: row.region,
    hidden: flag(row.is_hidden),
    cpu_name: row.cpu_info,
    cpu_cores: row.cpu_cores,
    arch: row.arch,
    os: row.os,
    kernel_version: row.kernel_version,
    version: row.agent_version,
    ipv4: admin && typeof row.ip_v4 === "string" && row.ip_v4.includes(".") ? row.ip_v4 : "",
    ipv6: admin && typeof row.ip_v6 === "string" && row.ip_v6.includes(":") ? row.ip_v6 : "",
    capability_ping: PROBES.some(([key]) => row[`ping_${key}`] !== undefined && row[`ping_${key}`] !== false && row[`ping_${key}`] !== "false") ? true : null,
    gpu_name: gpuRows(row.gpu_info).map(gpu => string(gpu.name)).filter(Boolean).join("、"),
    mem_total: number(row.ram_total) * MIB,
    swap_total: number(row.swap_total) * MIB,
    disk_total: number(row.disk_total) * MIB,
    weight: row.sort_order,
    price: settings.show_price === false ? 0 : price === 0 ? -1 : Number.isFinite(price) ? price : 0,
    billing_cycle: settings.show_price === false ? "" : billing < 0 ? row.billing_cycle : BILLING_DAYS[billing],
    auto_renewal: settings.show_price !== false && flag(row.auto_renewal),
    currency: row.currency === "¥JPY" ? "JPY" : row.currency,
    expired_at: settings.show_expire === false ? "" : row.expire_date,
    tags: row.tags,
    created_at: timeMs(row.timestamp) ? new Date(timeMs(row.timestamp)).toISOString() : "",
    updated_at: timeMs(row.last_updated) ? new Date(timeMs(row.last_updated)).toISOString() : "",
    traffic_limit: settings.show_tf === false ? 0 : quotaBytes(row.traffic_limit),
    traffic_limit_type: ({ dl: "down", ul: "up", max: "max" } as Record<string, string>)[string(row.traffic_calc_type)] ?? "sum",
    traffic_reset_day: number(row.reset_day),
    ipv4_reachable: flag(row.ip_v4),
    ipv6_reachable: flag(row.ip_v6),
  });
}

export function adminClient(row: Row, uuid: string) {
  return AdminClientSchema.parse({ ...nodeInfo(row, uuid, {}, true), remark: row.note });
}

export function loadPoint(row: Row, uuid: string, time = timeMs(row.timestamp)): LoadRecord {
  const load = string(row.load_avg ?? row.load).trim().split(/\s+/);
  const gpu = gpuRows(row.gpu_info);
  return {
    client: uuid,
    time,
    cpu: number(row.cpu),
    gpu: gpu.length ? Math.max(...gpu.map(item => number(item.info))) : 0,
    ram: number(row.ram_used) * MIB,
    ram_total: number(row.ram_total) * MIB,
    swap: number(row.swap_used) * MIB,
    swap_total: number(row.swap_total) * MIB,
    disk: number(row.disk_used) * MIB,
    disk_total: number(row.disk_total) * MIB,
    load: number(load[0] || row.load),
    temp: 0,
    net_in: number(row.net_in_speed),
    net_out: number(row.net_out_speed),
    net_total_up: number(row.net_tx),
    net_total_down: number(row.net_rx),
    process: number(row.processes),
    connections: number(row.tcp_conn),
    connections_udp: number(row.udp_conn),
  };
}

export function realtimePoint(row: Row, uuid: string, now = Date.now()) {
  const seen = timeMs(row.last_updated);
  if (!seen) return undefined;
  const load = string(row.load_avg ?? row.load).trim().split(/\s+/);
  const boot = timeMs(row.boot_time);
  return {
    ...loadPoint(row, uuid, seen),
    connections_tcp: number(row.tcp_conn),
    monthly_up: number(row.net_tx_monthly, NaN),
    monthly_down: number(row.net_rx_monthly, NaN),
    load5: number(load[1]),
    load15: number(load[2]),
    uptime: boot && boot <= seen ? Math.floor((seen - boot) / 1000) : 0,
    updated_at: seen,
    online: now - seen < ONLINE_WINDOW,
  };
}

export const PROBES = [
  ["ct", "电信", "custom_ct_name"], ["cu", "联通", "custom_cu_name"],
  ["cm", "移动", "custom_cm_name"], ["bd", "BGP", "custom_bd_name"],
  ["node_1", "Node 1", "node_1_name"], ["node_2", "Node 2", "node_2_name"],
  ["node_3", "Node 3", "node_3_name"], ["node_4", "Node 4", "node_4_name"],
] as const;

export function pingTasks(config: Row, source: number, uuid: string, row?: Row, targets: Row = {}): PingTask[] {
  return PROBES.flatMap(([key, label, name], index) => {
    if (row?.[`ping_${key}`] === false || row?.[`ping_${key}`] === "false") return [];
    const targetKey = index < 4 ? `custom_${key}` : key;
    return [{
      id: source * PROBES.length + index + 1,
      name: string(config[name]) || label,
      type: row?.ping_mode === "icmp" ? "icmp" : "tcp",
      interval: Math.max(1, number(row?.report_interval, 60)),
      clients: [uuid],
      target: string(targets[targetKey]),
      weight: index,
      loss: 0,
    }];
  });
}

export function pingPoints(row: Row, uuid: string, source: number, time: number): PingRecord[] {
  return PROBES.flatMap(([key], index) => {
    const value = row[`ping_${key}`], loss = row[`loss_${key}`];
    if (value === false || value === "false" || (value === undefined && loss == null)) return [];
    const latency = number(value, -1);
    const pct = number(loss, latency > 0 ? 0 : (value === null ? 100 : NaN));
    if (!Number.isFinite(pct)) return [];
    const lost = Math.max(0, Math.min(100, pct));
    // CF publishes percentages without the attempt count. Normalize each report
    // to equal weight to preserve its loss percentage without inventing a count.
    return [{
      task_id: source * PROBES.length + index + 1,
      client: uuid,
      time,
      value: latency > 0 ? latency : -1,
      sample_count: 1,
      loss_count: lost / 100,
      loss_rate: lost / 100,
    }];
  });
}

export function dashboardPingRows(server: Row): Row[] {
  const rows = new Map<number, Row>();
  for (const kind of ["ping", "loss"]) {
    const list = server[kind];
    if (!Array.isArray(list)) continue;
    for (const entry of list.map(object)) {
      const timestamp = timeMs(entry.ts);
      if (!timestamp) continue;
      const row = rows.get(timestamp) ?? { timestamp };
      for (const [key] of PROBES) {
        if (entry[key] !== undefined) row[`${kind}_${key}`] = entry[key];
      }
      rows.set(timestamp, row);
    }
  }
  return [...rows.values()];
}
