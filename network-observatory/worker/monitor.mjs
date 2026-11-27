import { MINUTE, TRAFFIC_INTERVAL, TRAFFIC_RETENTION, HttpError, json, parse, origin, requireInput } from "./common.mjs";
import model from "../plugin/src/model.js";

export function monitor(env, fetcher = fetch) {
  const backend = origin(env.CFSM_ORIGIN);
  const allowed = new Set([backend, ...String(env.BLACKWHITE_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean).map(origin)]);

  async function cfJson(path, headers) {
    const client = env.CFSM ? env.CFSM.fetch.bind(env.CFSM) : fetcher;
    let response;
    try {
      response = await client(new Request(backend + path, { headers, redirect: "manual", signal: AbortSignal.timeout(8_000) }));
    } catch {
      throw new HttpError(502, "无法连接 CF-Server-Monitor");
    }
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? response.status : 502, "CF-Server-Monitor 未授权或暂不可用");
    try {
      return await response.json();
    } catch {
      throw new HttpError(502, "CF-Server-Monitor 未返回有效的 JSON");
    }
  }

  function credentials(request, admin) {
    const headers = new Headers();
    for (const name of ["x-turnstile-verified", "x-turnstile-token"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (admin) {
      const bearer = request.headers.get("Authorization");
      if (bearer) headers.set("Authorization", bearer);
      const cookie = request.headers.get("Cookie")?.split(";").find(part => part.trimStart().startsWith("cfsm_auth="));
      if (cookie) headers.set("Cookie", cookie.trimStart());
    }
    return headers;
  }

  async function session(request, admin) {
    const headers = credentials(request, admin);
    if (admin) requireInput(headers.has("Authorization") || headers.has("Cookie"), "需要 CF-Server-Monitor 管理员登录", 401);
    const config = await cfJson("/api/config", headers);
    requireInput(admin ? config.authorization === true : config.is_public === true, admin ? "管理员会话无效" : "站点未公开", admin ? 401 : 403);
    requireInput(!config.turnstile_enabled || config.verified === true, "需要通过 Turnstile 验证", 403);
    return config;
  }

  async function list(request, includeCredentials = true) {
    const headers = request ? credentials(request, includeCredentials) : new Headers();
    if (!request && env.CFSM_APP_PASSWORD) headers.set("X-App-Password", env.CFSM_APP_PASSWORD);
    const { servers } = await cfJson("/api/servers", headers);
    requireInput(Array.isArray(servers), "CF-Server-Monitor 节点清单无效", 502);
    return servers.filter(row => typeof row?.id === "string" && model.UUID.test(row.id));
  }
  return { allowed, session, list };
}

function nodeInfo(row) {
  return {
    uuid: row.id.toLowerCase(), name: String(row.name || row.id).slice(0, 100),
    group: String(row.server_group || "").slice(0, 100),
    publicVisible: ![true, 1, "1", "true"].includes(row.is_hidden),
    ip: typeof row.ip_v4 === "string" && model.isHost(row.ip_v4) ? row.ip_v4 : "",
    ipv6: typeof row.ip_v6 === "string" && model.isHost(row.ip_v6) ? row.ip_v6 : "",
    resetDay: Number(row.reset_day) || null,
  };
}

export async function inventory(db) {
  return (await db.all("SELECT data FROM nodes ORDER BY id")).map(row => parse(row.data));
}

export async function refreshInventory(db, upstream, now, { interval = TRAFFIC_INTERVAL, capture = true, force = false } = {}) {
  const last = await db.one("SELECT ran_at FROM maintenance WHERE name = 'inventory'");
  if (!force && last && last.ran_at > now - interval) return false;
  // Losing or rejecting the CF request leaves the previous snapshot intact.
  const rows = await upstream.list();
  const nodes = rows.map(nodeInfo);
  const bucket = Math.floor(now / interval) * interval;
  const samples = [];
  if (capture) for (const row of rows) {
    if (row.net_tx == null || row.net_rx == null) continue;
    const source = Number(row.last_updated), tx = Number(row.net_tx), rx = Number(row.net_rx);
    if (!Number.isSafeInteger(source) || source < now - interval * 2 || source > now + MINUTE ||
        !Number.isFinite(tx) || tx < 0 || !Number.isFinite(rx) || rx < 0) continue;
    samples.push([row.id.toLowerCase(), bucket, source, tx, rx]);
  }

  // The snapshot and sample bucket commit together. Older overlapping runs cannot overwrite newer ones.
  await db.batch([
    db.statement("INSERT INTO maintenance VALUES ('inventory', ?) ON CONFLICT(name) DO UPDATE SET ran_at = excluded.ran_at WHERE excluded.ran_at > maintenance.ran_at", now),
    db.statement("DELETE FROM nodes WHERE id NOT IN (SELECT json_extract(value, '$.uuid') FROM json_each(?)) AND (SELECT ran_at FROM maintenance WHERE name='inventory') = ?", json(nodes), now),
    db.statement(`INSERT INTO nodes (id, data) SELECT json_extract(value, '$.uuid'), value FROM json_each(?)
      WHERE (SELECT ran_at FROM maintenance WHERE name='inventory') = ?
      ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE nodes.data <> excluded.data`, json(nodes), now),
    db.statement(`INSERT OR IGNORE INTO traffic
      SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]')
      FROM json_each(?) WHERE (SELECT ran_at FROM maintenance WHERE name='inventory') = ?
      AND NOT EXISTS (SELECT 1 FROM traffic t WHERE t.node = json_extract(value,'$[0]') AND t.source_at = json_extract(value,'$[2]')
        AND t.sampled_at >= json_extract(value,'$[1]') - ?)`, json(samples), now, 2 * interval),
  ]);
  return true;
}

export async function trafficHistory(db, upstream, request, body, now) {
  const { ids, start, end, points } = body;
  requireInput(Array.isArray(ids) && ids.length <= 128 && ids.every(id => typeof id === "string" && model.UUID.test(id)) &&
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end &&
    Number.isInteger(points) && points >= 2 && points <= 2000, "流量查询参数无效");
  const visible = new Set((await upstream.list(request)).map(row => row.id.toLowerCase()));
  const selected = [...new Set(ids.map(id => id.toLowerCase()))].filter(id => visible.has(id));
  if (!selected.length) return {};
  const from = Math.max(start, now - TRAFFIC_RETENTION);
  const to = Math.min(end, now + MINUTE);
  const oldestBucket = from - 30 * MINUTE;
  if (from > to) return {};
  // Bound the read and response size even if many nodes are selected together.
  const perNode = Math.min(points, Math.max(2, Math.floor(5000 / selected.length)));
  const sampleSize = Math.max(1, Math.ceil((to - from + 1) / Math.max(1, perNode - 1)));
  const rows = await db.all(`WITH selected AS (
    SELECT node, MIN(sampled_at) AS pick FROM traffic WHERE node IN (SELECT value FROM json_each(?))
      AND sampled_at BETWEEN ? AND ? AND source_at BETWEEN ? AND ? GROUP BY node, (source_at - ?) / ?
    UNION
    SELECT node, MAX(sampled_at) AS pick FROM traffic WHERE node IN (SELECT value FROM json_each(?))
      AND sampled_at BETWEEN ? AND ? AND source_at BETWEEN ? AND ? GROUP BY node
  )
  SELECT t.node, t.source_at AS timestamp, t.tx AS net_tx, t.rx AS net_rx FROM selected s
    JOIN traffic t ON t.node = s.node AND t.sampled_at = s.pick ORDER BY t.node, t.sampled_at`,
  json(selected), oldestBucket, to + 30 * MINUTE, from, to, from, sampleSize, json(selected), oldestBucket, to + 30 * MINUTE, from, to);
  const result = Object.fromEntries(selected.map(id => [id, []]));
  for (const { node, ...sample } of rows) result[node].push(sample);
  return result;
}
