import native from "../plugin/src/native-model.js";
import planner from "../plugin/src/report-model.js";
import bgp from "../plugin/src/bgp.js";
import globalping from "../plugin/src/globalping.js";
import { DAY, MINUTE, MAX_TARGETS, TRAFFIC_INTERVAL, boundedSetting, json, parse, requireInput, utcDay, edgeFetch, MAX_WORKERS } from "./common.mjs";
import { enqueueRound, finishJob } from "./reports.mjs";
import { inventory, refreshInventory } from "./monitor.mjs";

export function quotaPolicy(env) {
  return {
    idleSeconds: boundedSetting(env.BLACKWHITE_IDLE_SYNC_SECONDS, 300, 300, 1800),
    maxWorkers: boundedSetting(env.BLACKWHITE_MAX_PROBES, MAX_WORKERS, 1, MAX_WORKERS),
    dailyJobs: boundedSetting(env.BLACKWHITE_DAILY_JOBS, 400, 1, 800),
    storageBytes: boundedSetting(env.BLACKWHITE_RESULT_STORAGE_MIB, 180, 1, 240) * 1024 * 1024,
    maxResultBytes: boundedSetting(env.BLACKWHITE_RESULT_KIB, 768, 32, 1024) * 1024,
    globalping: env.BLACKWHITE_GLOBALPING === "true",
    paused: env.BLACKWHITE_PAUSE_AUTOMATION === "true",
  };
}

export async function quotaStatus(db, now, policy) {
  const [{ result_bytes: stored }, used, workers] = await Promise.all([
    db.one("SELECT result_bytes FROM storage_meter WHERE id=1"),
    db.one("SELECT jobs FROM job_budget WHERE day=?", utcDay(now)),
    db.one("SELECT COUNT(*) AS count FROM workers"),
  ]);
  const jobs = used?.jobs || 0;
  const pressure = stored >= policy.storageBytes * 0.85 || jobs >= policy.dailyJobs * 0.8;
  const guarded = policy.paused || jobs >= policy.dailyJobs || stored >= policy.storageBytes;
  return {
    mode: guarded ? "paused" : pressure ? "reduced" : "normal",
    estimatedIdleRequestsPerDay: Math.ceil(DAY / 1000 / policy.idleSeconds) * workers.count,
    jobs, jobLimit: policy.dailyJobs, storedBytes: stored, storageLimitBytes: policy.storageBytes,
    workers: workers.count, maxWorkers: policy.maxWorkers,
    trafficIntervalMinutes: guarded || pressure ? 30 : 15,
    nextResetAt: utcDay(now) + DAY,
  };
}

export async function settings(db) {
  const row = await db.one("SELECT revision,data FROM settings WHERE id=1");
  return { reportSuites: [], reportResources: [], reportSecrets: {}, endpoints: {}, ...parse(row.data), revision: row.revision };
}

export async function state(db, now, policy) {
  const [config, nodes, workerRows, timings] = await Promise.all([
    settings(db), inventory(db), db.all("SELECT id,metadata,status,seen_at,updates,update_status FROM workers"),
    db.all("SELECT * FROM schedules"),
  ]);
  const due = new Map(timings.map(row => [row.suite + ":" + row.module, row.due_at]));
  const workers = Object.fromEntries(workerRows.filter(row => row.seen_at).map(row => [row.id,
    { ...parse(row.status), online: row.seen_at > now - policy.idleSeconds * 4000 }]));
  const probes = Object.fromEntries(workerRows.filter(row => row.id.startsWith("probe:")).map(row => [row.id.slice(6),
    { ...parse(row.metadata), online: row.seen_at > now - policy.idleSeconds * 4000 }]));
  const endpointDefaults = Object.fromEntries(nodes.filter(node => node.ip || node.ipv6).map(node => [node.uuid,
    { address: node.ip || node.ipv6, ipv4: node.ip, ipv6: node.ipv6, port: 25201 }]));
  return {
    ...config, endpoints: { ...endpointDefaults, ...config.endpoints }, configuredEndpoints: config.endpoints,
    inventory: nodes, probes, workers, registeredNodes: workerRows.filter(row => row.id.startsWith("node:")).map(row => row.id.slice(5)),
    updates: Object.fromEntries(workerRows.filter(row => row.update_status !== '{}').map(row => [row.id, parse(row.update_status)])),
    updatePolicies: Object.fromEntries(workerRows.map(row => [row.id, { enabled: Boolean(row.updates) }])),
    reportSuites: config.reportSuites.map(suite => ({ ...suite, modules: suite.modules.map(module =>
      ({ ...module, nextAt: due.get(suite.id + ":" + module.module) || module.nextAt })) })),
  };
}

export async function writeSettings(db, config, previousRevision) {
  const { revision: _revision, ...data } = config;
  const serialized = json(data);
  const [changed] = await db.batch([
    db.statement("UPDATE settings SET data=?,revision=revision+1 WHERE id=1 AND revision=?", serialized, previousRevision),
    db.statement(`UPDATE dispatch SET revision=? WHERE revision=? AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND revision=? AND data=?)`,
      previousRevision + 1, previousRevision, previousRevision + 1, serialized),
  ]);
  requireInput(changed.meta.changes, "配置已变化，请刷新后保存", 409);
  return previousRevision + 1;
}

export function members(suite, nodes) {
  return nodes.filter(node => suite.clients.includes(node.uuid) || suite.groups.includes(node.group));
}

export function normalizeSuite(input, current) {
  let suite;
  try {
    suite = planner.normalizeSuite(input, current.reportResources);
  } catch (error) {
    requireInput(false, error.message);
  }
  const scope = members(suite, current.inventory);
  requireInput(scope.length > 0, "请选择至少一个节点或节点分组");
  if (!suite.inherit) {
    suite.clients = scope.map(node => node.uuid);
    suite.groups = [];
  }
  for (const module of suite.modules) {
    requireInput(module.sources.every(id => current.probes[id]), "选中的测量点不存在");
    const maximum = module.endpoints.length * (module.module === "routes" ? module.protocols.length : 1);
    requireInput(maximum <= MAX_TARGETS, `免费版每轮最多 ${MAX_TARGETS} 个测量目标`);
    requireInput(module.module !== "routes" ||
      (module.endpoints.length + module.sources.length * 2 + (module.publicSources ? 3 : 0)) * module.protocols.length <= MAX_TARGETS,
    `免费版每轮最多 ${MAX_TARGETS} 个线路目标`);
  }
  return suite;
}

export async function saveSuite(db, config, suite, previousRevision, now) {
  const { revision: _revision, ...data } = config;
  const nextRevision = previousRevision + 1;
  // Schedule changes and the revision update commit atomically. A racing
  // request can only succeed using the revision that it read.
  const claim = crypto.randomUUID();
  const tag = "mutation:" + claim;
  const schedules = suite.enabled ? suite.modules.filter(module => module.enabled).map(module => [
    module.module, native.next(module.timing, now),
  ]) : [];
  const statements = [
    db.statement(`INSERT INTO maintenance (name,ran_at) SELECT ?,?
      WHERE EXISTS (SELECT 1 FROM settings WHERE id=1 AND revision=?)`, tag, now, previousRevision),
    db.statement(`UPDATE settings SET data=?,revision=revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM maintenance WHERE name=?)`, json(data), tag),
    db.statement(`DELETE FROM schedules WHERE suite=? AND EXISTS(SELECT 1 FROM maintenance WHERE name=?)`, suite.id, tag),
    db.statement(`INSERT INTO schedules (suite,module,due_at) SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
      WHERE EXISTS(SELECT 1 FROM maintenance WHERE name=?)`, suite.id, json(schedules), tag),
    db.statement(`DELETE FROM dispatch WHERE suite=? AND EXISTS(SELECT 1 FROM maintenance WHERE name=?)`, suite.id, tag),
    db.statement(`UPDATE dispatch SET revision=? WHERE revision=? AND EXISTS(SELECT 1 FROM maintenance WHERE name=?)`,
      nextRevision, previousRevision, tag),
    db.statement(`UPDATE jobs SET state='cancelled',completed_at=?,lease_until=NULL,runtime=NULL,
      summary='{"state":"cancelled","diagnostic":"检测方案已停用或改变范围"}'
      WHERE completed_at IS NULL AND round_id IN(SELECT id FROM rounds WHERE suite=? AND finished_at IS NULL AND
      (module NOT IN (SELECT json_extract(value,'$[0]') FROM json_each(?)) OR
       node NOT IN (SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?))
        OR json_extract(data,'$.group') IN (SELECT value FROM json_each(?)))))
      AND EXISTS(SELECT 1 FROM maintenance WHERE name=?)`, now, suite.id, json(schedules), json(suite.clients), json(suite.groups), tag),
    db.statement("DELETE FROM maintenance WHERE name=?", tag),
  ];
  const [inserted] = await db.batch(statements);
  requireInput(inserted.meta.changes, "配置已变化，请刷新后保存", 409);
  return nextRevision;
}

export async function queueManual(db, current, suite, module, targets, now, policy, maintenanceBudget = 1) {
  requireInput(!targets || Array.isArray(targets) && targets.length <= 100 && targets.length > 0, "执行范围无效");
  const scope = members(suite, current.inventory).map(node => node.uuid);
  requireInput(!targets || targets.every(id => scope.includes(id)), "执行范围必须属于此方案");
  const nodes = targets ? [...new Set(targets)] : scope;
  requireInput(nodes.length, "当前方案没有可运行的节点");
  const modules = suite.modules.filter(item => item.enabled && (!module || module === item.module));
  requireInput(modules.length, "当前方案没有可运行的模块");
  const budget = await quotaStatus(db, now, policy);
  requireInput(budget.jobs < budget.jobLimit, "今日 Blackwhite 任务预算已用完，UTC 零点恢复", 429);
  const batches = modules.map(item => ({ id: crypto.randomUUID(), module: item.module }));
  const statements = batches.map(batch => db.statement(`INSERT INTO dispatch (id,suite,module,planned_at,created_at,nodes,revision)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT revision FROM settings WHERE id=1)=?`,
  batch.id, suite.id, batch.module, now, now, json(nodes), current.revision, current.revision));
  const inserted = await db.batch(statements);
  requireInput(inserted.every(result => result.meta.changes), "方案已更新，请刷新后重试", 409);
  const rounds = [];
  for (const batch of batches.slice(0, maintenanceBudget)) {
    const round = await processDispatch(db, current, now, policy, batch.id);
    if (round) rounds.push(round);
  }
  return { batchId: batches[0].id, rounds, queued: batches.length * nodes.length };
}

async function queueDue(db, current, now) {
  const due = await db.one("SELECT * FROM schedules WHERE due_at<=? ORDER BY due_at LIMIT 1", now);
  if (!due) return;
  const suite = current.reportSuites.find(item => item.id === due.suite && item.enabled);
  const module = suite?.modules.find(item => item.module === due.module && item.enabled);
  if (!module) return;
  const nodes = members(suite, current.inventory).map(node => node.uuid);
  const nextAt = native.next(module.timing, now);
  if (!Number.isFinite(nextAt) || nextAt <= now) return;
  const id = crypto.randomUUID();
  await db.batch([
    db.statement(`INSERT INTO dispatch(id,suite,module,planned_at,created_at,nodes,scheduled,revision)
      SELECT ?,?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM schedules WHERE suite=? AND module=? AND due_at=?)
      AND (SELECT revision FROM settings WHERE id=1)=?
      AND NOT EXISTS(SELECT 1 FROM dispatch WHERE suite=? AND module=? AND scheduled=1)`,
    id, suite.id, module.module, due.due_at, now, json(nodes), current.revision, suite.id, module.module, due.due_at, current.revision, suite.id, module.module),
    db.statement(`UPDATE schedules SET due_at=? WHERE suite=? AND module=? AND due_at=?
      AND (SELECT revision FROM settings WHERE id=1)=?`, nextAt, suite.id, module.module, due.due_at, current.revision),
  ]);
}

export async function processDispatch(db, current, now, policy, batchId, allowScheduled = true) {
  const pending = batchId ? await db.one("SELECT * FROM dispatch WHERE id=?", batchId) :
    await db.one(`SELECT * FROM dispatch WHERE scheduled<=? ORDER BY scheduled,created_at,id LIMIT 1`, Number(allowScheduled));
  if (!pending) return null;
  const suite = current.reportSuites.find(item => item.id === pending.suite && item.enabled);
  const module = suite?.modules.find(item => item.module === pending.module && item.enabled);
  const targets = parse(pending.nodes);
  if (!module || pending.revision !== current.revision || pending.cursor >= targets.length) {
    await db.change("DELETE FROM dispatch WHERE id=?", pending.id);
    return null;
  }
  const node = targets[pending.cursor];
  let round = null;
  if (current.inventory.some(item => item.uuid === node)) {
    round = await enqueueRound(db, current, suite, module, node, pending.id, pending.planned_at, now, policy)
      .catch(error => {
        if (error.status === 400) {
          console.warn("Blackwhite plan size or configuration invalid", error.message);
          return null;
        }
        throw error;
      });
    // Keep the cursor when a quota race reached the daily cap.
    if (!round) {
      const { jobs } = await quotaStatus(db, now, policy);
      if (jobs + MAX_TARGETS > policy.dailyJobs) return null;
    }
  }
  if (pending.cursor + 1 >= targets.length) await db.change("DELETE FROM dispatch WHERE id=? AND cursor=?", pending.id, pending.cursor);
  else await db.change("UPDATE dispatch SET cursor=cursor+1 WHERE id=? AND cursor=?", pending.id, pending.cursor);
  return round;
}

const publicProviders = {
  bgp: bgp.createBgpCollector({ fetcher: edgeFetch }),
  globalping: {
    create: job => globalping.create(job, edgeFetch),
    request: path => globalping.request(path, undefined, edgeFetch),
    normalize: globalping.normalize,
  },
};

async function processProvider(db, now, policy, providers) {
  const row = await db.one(`SELECT * FROM jobs WHERE executor IN ('globalping','bgp') AND completed_at IS NULL
    AND state IN ('queued','provider') AND available_at<=? AND expires_at>? ORDER BY available_at,id LIMIT 1`, now, now);
  if (!row) return;
  const job = parse(row.spec);
  if (job.operation === "globalping" && !policy.globalping) {
    await finishJob(db, row, { kind: "route", state: "missing", diagnostic: "公共 Globalping 测量未启用" }, now, policy);
    return;
  }
  const lock = now + MINUTE;
  const changed = await db.change("UPDATE jobs SET state='provider',available_at=?,lease_owner=? WHERE id=? AND available_at=? AND completed_at IS NULL",
    lock, String(lock), row.id, row.available_at);
  if (!changed) return;
  const processing = { ...row, state: "provider", lease_owner: String(lock) };
  try {
    if (job.operation === "bgp") {
      const data = await providers.bgp.collect(job.target);
      await finishJob(db, processing, data, now, policy);
      return;
    }
    if (!row.runtime) {
      const response = await providers.globalping.create(job);
      requireInput(typeof response.id === "string" && /^[\w-]{1,100}$/.test(response.id), "公共测量服务回复无效");
      await db.change("UPDATE jobs SET runtime=? WHERE id=? AND state='provider' AND lease_owner=?", json({ id: response.id }), row.id, String(lock));
      return;
    }
    const response = await providers.globalping.request("/measurements/" + parse(row.runtime).id);
    if (response.status === "in-progress") return;
    const [result] = providers.globalping.normalize(job, response);
    await finishJob(db, processing, result.data, now, policy);
  } catch (error) {
    if (error.rateLimited) {
      await db.change("UPDATE jobs SET available_at=? WHERE id=? AND state='provider' AND lease_owner=?", now + 60 * MINUTE, row.id, String(lock));
      return;
    }
    await finishJob(db, processing, { kind: planner.kindFor(job.operation), state: "missing", diagnostic: "外部测量服务暂不可用或缺少覆盖" }, now, policy);
  }
}

export async function runSchedule(db, upstream, now, policy, providers = publicProviders) {
  const quota = await quotaStatus(db, now, policy);
  try {
    await refreshInventory(db, upstream, now, { interval: quota.trafficIntervalMinutes * MINUTE || TRAFFIC_INTERVAL });
  } catch (error) {
    console.warn("Blackwhite inventory refresh failed", error.message);
  }
  const current = await state(db, now, policy);
  if (quota.mode === "normal") await queueDue(db, current, now);
  if (quota.jobs < policy.dailyJobs) await processDispatch(db, current, now, policy, undefined, quota.mode === "normal");
  if (quota.mode !== "paused") await processProvider(db, now, policy, providers);
}
