import native from "../plugin/src/native-model.js";
import planner from "../plugin/src/report-model.js";
import { MINUTE, identifier, json, parse, requireInput, token, tokenHash, readBody } from "./common.mjs";
import { finishJob, isLong } from "./reports.mjs";

const bearer = /^Bearer ([a-f0-9]{64})$/;
const allowedText = (items, limit) => Array.isArray(items) ? [...new Set(items.filter(item => typeof item === "string" && item.length <= 80))].slice(0, limit) : [];

async function authenticate(db, request, id) {
  const match = bearer.exec(request.headers.get("Authorization") || "");
  requireInput(match, "探测器凭证无效", 401);
  // The lookup contains the hash in the predicate; cleartext tokens never persist.
  const row = await db.one(`SELECT * FROM workers WHERE id=? AND token_hash=?
    AND (id LIKE 'probe:%' OR EXISTS(SELECT 1 FROM nodes WHERE id=substr(workers.id,6)))`, id, await tokenHash(match[1]));
  requireInput(row, "探测器凭证无效或节点已移除", 401);
  return row;
}

export async function registerWorker(db, id, meta, maxWorkers) {
  const secret = token();
  const changed = await db.change(`INSERT INTO workers (id,token_hash,metadata)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM workers) < ? OR EXISTS(SELECT 1 FROM workers WHERE id = ?)
    ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,metadata=excluded.metadata,
    status='{}',seen_at=0,session='',maintenance_until=0,maintenance_id='',update_status='{}'`, id, await tokenHash(secret), json(meta), maxWorkers, id);
  requireInput(changed, `已到免费版的 ${maxWorkers} 个探测器上限`, 409);
  return secret;
}

function workerStatus(body, now) {
  return {
    seenAt: now, version: native.text(body.version, 32), tools: allowedText(body.tools, 32),
    authScheme: ["oaep", "pkcs1"].includes(body.authScheme) ? body.authScheme : "unavailable",
    features: allowedText(body.features, 48),
    missingDiagnosticTools: allowedText(body.missingDiagnosticTools, 32),
  };
}

async function sync(db, probe, body, now, policy, settings) {
  requireInput(typeof body.instanceId === "string" && /^[0-9a-f]{32}$/.test(body.instanceId), "探测器会话标识无效");
  const status = workerStatus(body, now);
  const previously = parse(probe.status);
  const { seenAt: _timestamp, ...fields } = status;
  const { seenAt: _before, ...before } = previously;
  if (probe.session !== body.instanceId || probe.seen_at <= now - policy.idleSeconds * 2000 || json(fields) !== json(before)) {
    await db.change("UPDATE workers SET seen_at=?,status=?,session=? WHERE id=? AND token_hash=? AND seen_at<=?",
      now, json(status), body.instanceId, probe.id, probe.token_hash, now);
  }
  const alive = allowedText(body.activeJobIds, 12).filter(id => /^[0-9a-f-]{36}$/.test(id));
  if (alive.length) {
    await db.change(`UPDATE jobs SET lease_until=MIN(expires_at,?)
      WHERE executor=? AND state='running' AND lease_until>? AND lease_until<? AND id IN (SELECT value FROM json_each(?))`,
    now + 3 * MINUTE, probe.id, now, now + 90_000, json(alive));
  }

  const current = await db.all(`SELECT * FROM jobs WHERE completed_at IS NULL AND lease_until>?
    AND (executor=? OR (operation='benchmark' AND json_extract(spec,'$.nodeUuid')=?))
    AND state IN ('listening','ready','running') LIMIT 12`, now, probe.id, probe.id.startsWith("node:") ? probe.id.slice(5) : "");
  const activeJobIds = current.filter(job => job.executor === probe.id && job.state === "running").map(job => job.id);
  const listeners = current.filter(job => job.operation === "benchmark" && probe.id === "node:" + parse(job.spec).nodeUuid).map(job => job.id);
  const response = { task: null, listeners, activeJobIds, nextSyncSeconds: current.length ? 30 : policy.idleSeconds };
  if (probe.maintenance_until > now || body.allowTask === false) return response;
  const claimExisting = current.find(job => job.executor === probe.id && job.state === "running" &&
    job.lease_owner === body.instanceId && !alive.includes(job.id));
  if (claimExisting) {
    response.task = await assignedTask(claimExisting, settings);
    return response;
  }
  const ready = current.find(job => job.executor === probe.id && job.operation === "benchmark" && job.state === "ready");
  if (ready) {
    const claimed = await db.change(`UPDATE jobs SET state='running',lease_owner=?,lease_until=?,started_at=?
      WHERE id=? AND state='ready' AND lease_until>?
      AND EXISTS(SELECT 1 FROM workers WHERE id=? AND token_hash=? AND session=? AND maintenance_until<=?)`,
    body.instanceId, now + 3 * MINUTE, now, ready.id, now, probe.id, probe.token_hash, body.instanceId, now);
    if (claimed) {
      response.task = await assignedTask(ready, settings);
      response.activeJobIds.push(ready.id);
    }
    return response;
  }
  const listen = current.find(job => listeners.includes(job.id) && job.state === "listening" && job.lease_owner === body.instanceId);
  if (listen && !(Array.isArray(body.listeners) && body.listeners.includes(listen.id))) {
    response.task = listenTask(listen);
    return response;
  }
  if (current.length || !status.features.includes("report-v3")) return response;

  const candidate = await db.one(`SELECT * FROM jobs WHERE state='queued' AND available_at<=? AND expires_at>?
    AND ((operation<>'benchmark' AND executor=?) OR (operation='benchmark' AND json_extract(spec,'$.nodeUuid')=?))
    ORDER BY available_at,id LIMIT 1`, now, now, probe.id, probe.id.startsWith("node:") ? probe.id.slice(5) : "");
  if (!candidate) return response;
  const operation = candidate.operation;
  const spec = parse(candidate.spec);
  if (isLong(operation) && !status.features.includes(operation)) {
    await finishJob(db, candidate, { kind: operation, state: "missing", diagnostic: "探测器完整检测执行器未就绪" }, now, policy);
    return response;
  }
  const listenMode = operation === "benchmark";
  let runtime = null;
  if (listenMode) {
    const other = await db.one("SELECT status,seen_at FROM workers WHERE id=?", candidate.executor);
    if (!other || other.seen_at <= now - policy.idleSeconds * 4000) return response;
    const peer = parse(other.status);
    if (peer.authScheme === "unavailable" || status.authScheme === "unavailable" || !status.tools.includes("openssl")) {
      await finishJob(db, candidate, { kind: "speed", state: "missing", diagnostic: "两端需要支持认证的 iperf3，VPS 端另需 openssl" }, now, policy);
      return response;
    }
    runtime = json({ password: token(), peerScheme: peer.authScheme });
  }
  const leaseFor = isLong(operation) ? (Number(spec.options.timeoutMinutes || 120) + 15) * MINUTE : listenMode ? 7 * MINUTE : 3 * MINUTE;
  const claimed = await db.change(`UPDATE jobs SET state=?, lease_owner=?,lease_until=MIN(expires_at,?),started_at=?,runtime=?
    WHERE id=? AND state='queued' AND expires_at>?
    AND EXISTS(SELECT 1 FROM workers WHERE id=? AND token_hash=? AND session=? AND maintenance_until<=?)
    AND NOT EXISTS (SELECT 1 FROM jobs occupied WHERE occupied.completed_at IS NULL AND occupied.lease_until>? AND
      (occupied.executor=? OR (occupied.operation='benchmark' AND json_extract(occupied.spec,'$.nodeUuid')=?) OR
      (? = 'benchmark' AND occupied.executor=?) OR
       (? IN ('http-speed','iperf-speed','public-speed') AND occupied.operation IN ('http-speed','iperf-speed','public-speed') AND
        (? = 'public-speed' OR json_extract(occupied.spec,'$.target')=?))))`,
  listenMode ? "listening" : "running", body.instanceId, now + leaseFor, now, runtime, candidate.id, now,
  probe.id, probe.token_hash, body.instanceId, now, now, probe.id, probe.id.slice(5), operation, candidate.executor, operation, operation, spec.target);
  if (claimed) {
    response.nextSyncSeconds = 30;
    if (listenMode) {
      response.task = listenTask({ ...candidate, runtime });
      response.listeners.push(candidate.id);
    } else {
      response.task = await assignedTask(candidate, settings);
      response.activeJobIds.push(candidate.id);
    }
  }
  return response;
}

function listenTask(job) {
  const spec = parse(job.spec), runtime = parse(job.runtime);
  return { id: job.id, operation: "listen", options: { port: spec.options.port, password: runtime.password, peerScheme: runtime.peerScheme, lifetime: 600 } };
}

async function assignedTask(job, settings) {
  const spec = parse(job.spec);
  if (job.operation === "benchmark" && job.runtime) {
    const { password, publicKey, scheme } = parse(job.runtime);
    spec.credentials = { password, publicKey, scheme };
  } else if (spec.options?.endpoint?.id) {
    const auth = (await settings()).reportSecrets?.[spec.options.endpoint.id];
    if (auth) spec.credentials = { token: auth };
  }
  return spec;
}

async function preserveReportLink(db, job, data, now, policy) {
  if (!isLong(job.operation) || !data?.reportUrl) return;
  try {
    native.validateResult(data, job.operation);
  } catch {
    return;
  }
  const row = await db.one("SELECT body,bytes FROM results WHERE job_id=? AND expires_at>?", job.id, now);
  if (!row) return;
  const original = parse(row.body);
  if (original.reportUrl) return;
  const merged = json({ ...original, reportUrl: data.reportUrl });
  const bytes = new TextEncoder().encode(merged).length;
  if (bytes > policy.maxResultBytes) return;
  await db.change(`UPDATE results SET body=?,bytes=? WHERE job_id=? AND expires_at>? AND bytes=?
    AND COALESCE(json_extract(body,'$.reportUrl'),'')=''
    AND (SELECT result_bytes FROM storage_meter WHERE id=1) + ? <= ?`,
  merged, bytes, job.id, now, row.bytes, bytes - row.bytes, policy.storageBytes);
}

async function receiveResult(db, probe, body, now, policy) {
  const id = identifier(body.id);
  const job = await db.one("SELECT * FROM jobs WHERE id=?", id);
  requireInput(job, "任务已结束", 409);
  if (job.operation === "benchmark" && probe.id === "node:" + parse(job.spec).nodeUuid) {
    const data = body.data;
    if (["ready", "running"].includes(job.state)) return { ok: true, replay: true };
    requireInput(job.state === "listening" && job.lease_until > now && body.instanceId === job.lease_owner, "监听租约已结束", 409);
    if (data?.state === "ready") {
      requireInput(typeof data.publicKey === "string" && data.publicKey.startsWith("-----BEGIN PUBLIC KEY-----") &&
        data.publicKey.length < 4096 && ["oaep", "pkcs1"].includes(data.scheme), "测速监听凭证无效");
      const updated = await db.change(`UPDATE jobs SET state='ready', runtime=? WHERE id=? AND state='listening' AND lease_owner=?`,
      json({ ...parse(job.runtime), publicKey: data.publicKey, scheme: data.scheme }), id, body.instanceId);
      requireInput(updated, "监听状态已变化，请重试", 409);
      return { ok: true };
    }
    await finishJob(db, job, { kind: "speed", state: "failed", diagnostic: "测速监听启动失败" }, now, policy);
    return { ok: true };
  }
  requireInput(job.executor === probe.id && job.started_at != null, "任务不属于该探测器", 409);
  if (job.completed_at != null && ["ok", "partial", "failed", "application"].includes(job.state) && job.lease_owner &&
      !parse(job.summary || "{}").diagnostic?.startsWith("探测器失联")) {
    await preserveReportLink(db, job, body.data, now, policy);
    const stored = await db.one("SELECT job_id FROM results WHERE job_id=? AND expires_at>?", id, now);
    return { ok: true, replay: true, detailStored: Boolean(stored) };
  }
  requireInput(job.state === "running" && job.lease_until > now &&
    (body.instanceId === job.lease_owner || body.outbox === true), "任务租约已结束", 409);
  try {
    native.validateResult(body.data, planner.kindFor(job.operation));
  } catch (error) {
    requireInput(false, error.message);
  }
  const done = await finishJob(db, job, body.data, now, policy);
  if (!done) {
    const saved = await db.one("SELECT completed_at,summary FROM jobs WHERE id=? AND executor=?", id, probe.id);
    requireInput(saved?.completed_at != null && !["missing", "cancelled"].includes(parse(saved.summary || "{}").state), "任务租约已结束", 409);
  }
  const stored = await db.one("SELECT job_id FROM results WHERE job_id=? AND expires_at>?", id, now);
  return { ok: true, replay: !done, detailStored: Boolean(stored) };
}

export async function probeRoute(db, request, role, uuid, action, now, policy, settings, release) {
  const probe = await authenticate(db, request, role + ":" + identifier(uuid));
  if (action === "verify") return { ok: true, sync: true, minSyncSeconds: policy.idleSeconds };
  if (action === "update-policy") return { enabled: probe.updates === 1, release,
    version: parse(probe.status).version || "", instanceId: probe.session, busy: await isBusy(db, probe.id, now) };
  if (action === "poll" || action === "heartbeat") return { ok: true, task: null, listeners: [], upgradeRequired: true, activeJobIds: [] };
  if (action === "sync") return sync(db, probe, await readBody(request, 28_000), now, policy, settings);
  if (action === "result") return receiveResult(db, probe, await readBody(request, 1_080_000), now, policy);
  if (action === "maintenance") return maintain(db, probe, await readBody(request), now, release);
  requireInput(false, "接口不存在", 404);
}


async function isBusy(db, id, now) {
  return Boolean(await db.one(`SELECT id FROM jobs WHERE completed_at IS NULL AND lease_until>?
    AND (executor=? OR (operation='benchmark' AND json_extract(spec,'$.nodeUuid')=?)) LIMIT 1`, now, id, id.startsWith("node:") ? id.slice(5) : ""));
}

async function maintain(db, probe, body, now, release) {
  const status = (state, message) => json({ state, message: native.text(message, 300), at: new Date(now).toISOString() });
  const states = ["ok", "waiting", "failed"];
  if (body.action === "report") {
    requireInput(states.includes(body.state), "维护状态无效");
    const previous = parse(probe.update_status);
    if (previous.state !== body.state || previous.message !== native.text(body.message, 300))
      await db.change("UPDATE workers SET update_status=? WHERE id=? AND token_hash=?", status(body.state, body.message), probe.id, probe.token_hash);
    return { ok: true };
  }
  if (body.action === "claim") {
    requireInput(body.version === release.version && (!body.automatic || probe.updates === 1), "探测器版本或自动更新授权无效", 409);
    requireInput(!await isBusy(db, probe.id, now), "测量端忙，等待当前测量完成", 409);
    const lease = token().slice(0, 32);
    const changed = await db.change(`UPDATE workers SET maintenance_id=?,maintenance_until=?,update_status=?
      WHERE id=? AND token_hash=? AND maintenance_until<=? AND NOT EXISTS(SELECT 1 FROM jobs
        WHERE completed_at IS NULL AND lease_until>? AND (executor=? OR (operation='benchmark' AND json_extract(spec,'$.nodeUuid')=?)))`,
    lease, now + 10 * MINUTE, status("updating", "已进入维护"), probe.id, probe.token_hash, now, now,
    probe.id, probe.id.startsWith("node:") ? probe.id.slice(5) : "");
    requireInput(changed, "测量端忙或已有维护租约", 409);
    return { lease };
  }
  requireInput(body.action === "release" && typeof body.lease === "string" && /^[a-f0-9]{32}$/.test(body.lease), "维护租约无效", 409);
  const changed = await db.change("UPDATE workers SET maintenance_id='',maintenance_until=0,update_status=? WHERE id=? AND token_hash=? AND maintenance_id=?",
    status(states.includes(body.state) ? body.state : "failed", body.message), probe.id, probe.token_hash, body.lease);
  requireInput(changed, "维护租约无效", 409);
  return { ok: true };
}
