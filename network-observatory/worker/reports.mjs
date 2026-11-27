import native from "../plugin/src/native-model.js";
import planner from "../plugin/src/report-model.js";
import shape from "../plugin/src/report-shape.js";
import routes from "../plugin/src/route-evidence.js";
import routeHome from "../plugin/src/home-routes.js";
import speedHome from "../plugin/src/home-speeds.js";
import { DAY, DETAIL_RETENTION, MAX_TARGETS, MINUTE, identifier, json, parse, requireInput, utcDay } from "./common.mjs";

const long = new Set(["tcpquality-full", "nodequality-full"]);
const iso = value => new Date(value).toISOString();

export function isLong(operation) { return long.has(operation); }

function targetSpec(options) {
  // Credentials go to the assigned probe only, never into slots or reports.
  const result = { ...options };
  if (result.endpoint) {
    const { token: _token, ...endpoint } = result.endpoint;
    result.endpoint = endpoint;
  }
  return result;
}

export function planRound(state, suite, module, node, id = crypto.randomUUID()) {
  const plan = planner.planSlots(state, suite, module, node, id);
  requireInput(plan.slots.length <= MAX_TARGETS, `免费版每轮最多 ${MAX_TARGETS} 个测量目标，请拆分方案`);
  return { ...plan, id };
}

export async function enqueueRound(db, state, suite, module, node, batch, plannedAt, now, policy) {
  const { id, slots, jobs } = planRound(state, suite, module, node);
  const candidates = jobs.map((job, index) => {
    const slot = slots[index];
    return {
      id: job.id, executor: job.executor, operation: job.operation,
      slot: { ...slot, options: targetSpec(slot.options) },
      spec: { ...job, options: targetSpec(job.options) },
      state: job.missingReason ? "missing" : "queued",
      summary: job.missingReason ? { kind: planner.kindFor(job.operation), state: "missing", diagnostic: job.missingReason } : null,
    };
  });
  const active = candidates.filter(item => item.state === "queued").length;
  const statements = [
    db.statement(`INSERT OR IGNORE INTO rounds
      (id,node,suite,module,batch,planned_at,started_at,finished_at,parameters,catalog_version)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM dispatch d JOIN settings s ON s.id = 1 AND s.revision = d.revision WHERE d.id = ?)
      AND COALESCE((SELECT jobs FROM job_budget WHERE day = ?),0) + ? <= ?`,
    id, node, suite.id, module.module, batch, plannedAt, now, active ? null : now, json(module), suite.catalogVersion,
    batch, utcDay(now), active, policy.dailyJobs),
    db.statement(`INSERT INTO jobs (id,round_id,executor,operation,slot,spec,state,available_at,expires_at,completed_at,summary)
      SELECT json_extract(value,'$.id'), ?, json_extract(value,'$.executor'), json_extract(value,'$.operation'),
      json_extract(value,'$.slot'), json_extract(value,'$.spec'), json_extract(value,'$.state'), ?, ?,
      CASE WHEN json_extract(value,'$.state') = 'missing' THEN ? ELSE NULL END, json_extract(value,'$.summary')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM rounds WHERE id = ?)`,
    id, now, now + 6 * 60 * MINUTE, now, json(candidates), id),
    db.statement(`INSERT INTO job_budget (day, jobs) SELECT ?, ? WHERE ? > 0 AND EXISTS(SELECT 1 FROM rounds WHERE id = ?)
      ON CONFLICT(day) DO UPDATE SET jobs = job_budget.jobs + excluded.jobs`, utcDay(now), active, active, id),
  ];
  const [inserted] = await db.batch(statements);
  return inserted.meta.changes ? id : null;
}

export function measurement(row, round, slot, data) {
  const spec = parse(row.spec);
  return {
    id: row.id, roundId: round.id, slotId: slot.id, nodeUuid: round.node,
    target: spec.target, direction: spec.direction, operation: row.operation, pairId: spec.pairId || "",
    executor: row.executor, source: spec.source, options: slot.options,
    startedAt: row.started_at == null ? null : iso(row.started_at), completedAt: iso(row.completed_at),
    data,
  };
}

function readSummary(round, slots, now) {
  const parameters = parse(round.parameters);
  return shape.summarize({
    id: round.id, nodeUuid: round.node, suiteId: round.suite, batchId: round.batch, module: round.module,
    plannedAt: iso(round.planned_at), startedAt: iso(round.started_at), completedAt: round.finished_at == null ? null : iso(round.finished_at),
    slots, parameters, detailAvailable: Boolean(round.detail_available) && (round.finished_at == null || round.finished_at + DETAIL_RETENTION > now),
  });
}

export async function report(db, node, id, now, includeDetails = true) {
  const row = await db.one("SELECT * FROM rounds WHERE id=? AND node=?", identifier(id), identifier(node));
  requireInput(row, "报告不存在", 404);
  const jobs = await db.all(`SELECT j.*, ${includeDetails ? "r.body" : "NULL AS body"} FROM jobs j
    ${includeDetails ? "LEFT JOIN results r ON r.job_id=j.id AND r.expires_at > ?" : ""}
    WHERE j.round_id = ? ORDER BY j.rowid`, ...(includeDetails ? [now, id] : [id]));
  const slots = jobs.map(job => {
    const slot = parse(job.slot);
    const metrics = job.summary ? parse(job.summary) : undefined;
    return {
      ...slot, state: job.state, metrics,
      ...(job.completed_at == null ? {} : { completedAt: iso(job.completed_at) }),
      missingReason: metrics?.diagnostic || slot.missingReason,
    };
  });
  const summary = readSummary(row, slots, now);
  return {
    ...summary, parameters: parse(row.parameters), catalogVersion: row.catalog_version, slots,
    measurements: includeDetails ? jobs.flatMap((job, index) => job.body && job.completed_at != null ?
      [measurement(job, row, slots[index], parse(job.body))] : []) : [],
  };
}

export async function listReports(db, node, url, now, history = false) {
  identifier(node);
  const module = url.searchParams.get("module");
  const suite = url.searchParams.get("suite") || "";
  requireInput(!module || shape.MODULES.includes(module), "报告模块无效");
  if (suite) identifier(suite);
  const cursor = url.searchParams.get("cursor") || "";
  const match = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(cursor);
  requireInput(!cursor || match, "报告游标无效");
  const limit = history ? 8 : 16;
  const rounds = await db.all(`SELECT * FROM rounds WHERE node=?
    ${module ? "AND module=?" : ""} ${suite ? "AND suite=?" : ""}
    ${match ? "AND (planned_at, id) < (?,?)" : ""}
    ORDER BY planned_at DESC,id DESC LIMIT ?`, node, ...(module ? [module] : []), ...(suite ? [suite] : []),
    ...(match ? [Number(match[1]), identifier(match[2])] : []), limit + 1);
  const page = rounds.slice(0, limit);
  const groups = new Map(page.map(row => [row.id, []]));
  if (page.length) {
    const cols = history ? "round_id, state, slot, summary" : "round_id, state";
    const jobs = await db.all(`SELECT ${cols} FROM jobs WHERE round_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`, json([...groups.keys()]));
    for (const job of jobs) {
      const slot = history ? { ...parse(job.slot), metrics: job.summary ? parse(job.summary) : undefined } : {};
      groups.get(job.round_id).push({ ...slot, state: job.state });
    }
  }
  const summaries = page.map(row => {
    const slots = groups.get(row.id);
    const summary = readSummary(row, slots, now);
    return history ? { ...summary, slots } : summary;
  });
  const last = page.at(-1);
  return { rounds: summaries, nextCursor: last && rounds.length > limit ? `${last.planned_at}:${last.id}` : null };
}

export async function finishJob(db, row, data, now, policy, options = {}) {
  const spec = parse(row.spec);
  const normalized = data.kind === "route" ? { ...data, routeEvidence: routes.routeFacts(data.hops || []) } : data;
  const summary = shape.metrics(normalized);
  if (normalized.diagnostic) summary.diagnostic = String(normalized.diagnostic).slice(0, 500);
  const body = json(normalized);
  const bytes = new TextEncoder().encode(body).length;
  const writePayload = bytes <= policy.maxResultBytes;
  const gate = "id=? AND completed_at IS NULL AND state=? AND lease_owner IS ? AND lease_until IS ? AND runtime IS ?";
  const args = [row.id, row.state, row.lease_owner, row.lease_until, row.runtime];
  const writes = [
    db.statement(`INSERT OR IGNORE INTO results (job_id,expires_at,body,bytes)
      SELECT id,?,?,? FROM jobs WHERE ${gate}
      AND (SELECT result_bytes FROM storage_meter WHERE id=1) + ? <= ?`,
    now + DETAIL_RETENTION, body, bytes, ...args, bytes, writePayload ? policy.storageBytes : -1),
    db.statement(`UPDATE rounds SET detail_available=0 WHERE id=?
      AND EXISTS(SELECT 1 FROM jobs WHERE ${gate}) AND NOT EXISTS(SELECT 1 FROM results WHERE job_id=?)`,
    row.round_id, ...args, row.id),
    db.statement(`UPDATE jobs SET state=?, completed_at=?, summary=?, lease_until=NULL, runtime=NULL
      WHERE ${gate}`, data.state, now, json(summary), ...args),
  ];
  const [, , finished] = await db.batch(writes);
  if (!finished.meta.changes) return false;
  if (options.project === false) return true;

  try {
    const projected = routeHome.project({ id: row.id, roundId: row.round_id, source: spec.source, operation: row.operation,
      direction: spec.direction, options: spec.options, completedAt: iso(now), data: normalized });
    if (projected) await saveProjection(db, spec.nodeUuid, "routes", projected.family, projected.carrier + ":" + projected.direction, now, projected);
    if (["ip-quality", "media-unlock"].includes(data.kind)) {
      const family = spec.options.family || "4";
      await saveProjection(db, spec.nodeUuid, data.kind, family, "", now, { ...summary, reportId: row.round_id, at: iso(now) });
    }
    if (data.kind === "speed" && spec.reportModule === "china-speed") {
      const round = await report(db, spec.nodeUuid, row.round_id, now, false);
      if (round.completedAt) {
        const result = speedHome.projectRound(round);
        if (result) await saveProjection(db, spec.nodeUuid, "china-speed", result.family, "", now, result);
      }
    }
  } catch (error) {
    // A cached homepage summary never changes the durable receipt.
    console.warn("Blackwhite homepage projection failed", error.name);
  }
  return true;
}

export async function saveProjection(db, node, module, family, source, at, value) {
  await db.change(`INSERT INTO projections VALUES (?,?,?,?,?,?) ON CONFLICT(node,module,family,source)
    DO UPDATE SET at=excluded.at, data=excluded.data WHERE excluded.at >= projections.at`,
  node, module, family, source, at, json(value));
}

export async function cancelRound(db, node, id, now) {
  identifier(node);
  identifier(id);
  const result = await db.change(`UPDATE jobs SET state='cancelled',completed_at=?,lease_until=NULL,runtime=NULL,
    summary='{"state":"cancelled","diagnostic":"管理员取消本轮检测"}'
    WHERE round_id=? AND completed_at IS NULL AND EXISTS(SELECT 1 FROM rounds WHERE id=? AND node=?)`, now, id, id, node);
  return { ok: true, cancelled: result };
}

export async function expireJobs(db, now) {
  await db.change(`UPDATE jobs SET state='missing',completed_at=?,lease_until=NULL,runtime=NULL,
    summary='{"state":"missing","diagnostic":"测量端未完成任务或租约到期"}'
    WHERE id IN (SELECT id FROM jobs WHERE completed_at IS NULL AND expires_at<=? LIMIT 48)`, now, now);
  await db.change(`UPDATE jobs SET state='failed',completed_at=?,lease_until=NULL,runtime=NULL,
    summary='{"state":"failed","diagnostic":"探测器失联，保留结果重试窗口后结束"}'
    WHERE id IN (SELECT id FROM jobs WHERE completed_at IS NULL AND lease_until<=? AND state IN ('running','listening','ready') LIMIT 48)`, now, now);
}

export async function cleanReports(db, now) {
  // Small deletes limit quota spikes after deployments or downtime.
  await db.batch([
    db.statement("DELETE FROM results WHERE job_id IN (SELECT job_id FROM results WHERE expires_at <= ? LIMIT 48)", now),
    db.statement("DELETE FROM shares WHERE token_hash IN (SELECT token_hash FROM shares WHERE expires_at <= ? LIMIT 48)", now),
    db.statement("DELETE FROM rounds WHERE id IN (SELECT id FROM rounds WHERE finished_at <= ? LIMIT 4)", now - 90 * DAY),
    db.statement("DELETE FROM traffic WHERE (node,sampled_at) IN (SELECT node,sampled_at FROM traffic WHERE sampled_at<=? LIMIT 64)", now - 45 * DAY),
    db.statement("DELETE FROM projections WHERE (node,module,family,source) IN (SELECT node,module,family,source FROM projections WHERE at <= ? LIMIT 32)", now - 90 * DAY),
    db.statement("DELETE FROM dispatch WHERE id IN (SELECT id FROM dispatch WHERE created_at <= ? LIMIT 16)", now - DAY),
    db.statement("DELETE FROM job_budget WHERE day < ?", utcDay(now) - DAY),
  ]);
}
