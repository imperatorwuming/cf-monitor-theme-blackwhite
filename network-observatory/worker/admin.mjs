import planner from "../plugin/src/report-model.js";
import native from "../plugin/src/native-model.js";
import shape from "../plugin/src/report-shape.js";
import resources from "../plugin/src/report-resources.js";
import catalog from "../plugin/src/report-catalog.js";
import sharing from "../plugin/src/report-share.js";
import assets from "../plugin/src/report-assets.js";
import release from "../plugin/src/runner-release.json" with { type: "json" };
import diagnostics from "../plugin/src/home-diagnostics.js";
import { BASE, DAY, MINUTE, MAX_TARGETS, DETAIL_RETENTION, SUMMARY_RETENTION, identifier, parse, json, readBody, requireInput, token, tokenHash, edgeFetch } from "./common.mjs";
import { refreshInventory } from "./monitor.mjs";
import { registerWorker } from "./probes.mjs";
import { cancelRound, listReports, planRound, report } from "./reports.mjs";
import { members, normalizeSuite, queueManual, quotaStatus, saveSuite, settings, state, writeSettings } from "./schedule.mjs";

export const capabilities = {
  schema: 3, modules: shape.MODULES, maxTargetsPerRound: MAX_TARGETS,
  features: ["serverless-free", "rounds", "original-report-images", "suite-history", "latency-samples", "full-mtr", "bgp-rpki",
    "speed-intervals", "http-speed", "tcp-quality", "public-speed", "tcpquality-full", "nodequality-full",
    ...diagnostics.DIAGNOSTICS, "home-diagnostics", "home-diagnostic-display", "home-ip-capability", "home-ip-capability-default"],
  retention: { detailDays: DETAIL_RETENTION / DAY, summaryDays: SUMMARY_RETENTION / DAY },
};

const originalAssets = assets.createReportAssets({ fetcher: edgeFetch });

function cfgWith(current, patch) {
  return { ...current, ...patch };
}

function workerCatalog(current) {
  return {
    revision: current.revision, inventory: current.inventory, runnerRelease: release, mode: "serverless-free",
    workers: current.workers, registeredNodes: current.registeredNodes, updatePolicies: current.updatePolicies, updates: current.updates,
    probes: Object.entries(current.probes).map(([id, probe]) => ({ id, ...probe })),
    endpoints: current.endpoints,
  };
}

function reportCatalog(current, quota) {
  return {
    ...workerCatalog(current),
    ...capabilities, catalogVersion: catalog.VERSION, endpoints: planner.directory(current), presets: catalog.PRESETS,
    suites: current.reportSuites, inventory: current.inventory, timezones: native.TIMEZONES,
    homeRouteNodes: current.homeRouteNodes || [], homeRouteDisplay: current.homeRouteDisplay !== false,
    homeRouteLabelMode: current.homeRouteLabelMode || "preferred", homeRouteShowDetails: current.homeRouteShowDetails === true,
    homeSpeedNodes: current.homeSpeedNodes || [], homeSpeedDisplay: current.homeSpeedDisplay !== false,
    homeSpeedShowDetails: current.homeSpeedShowDetails === true,
    homeDiagnosticNodes: current.homeDiagnosticNodes || {}, homeDiagnosticDisplay: current.homeDiagnosticDisplay || {},
    ipCapabilityExpanded: current.ipCapabilityExpanded !== false,
    quota,
  };
}

async function initialState(db, upstream, now, policy) {
  const initialized = await db.one("SELECT ran_at FROM maintenance WHERE name='inventory'");
  if (!initialized) {
    try {
      await refreshInventory(db, upstream, now);
    } catch (error) {
      const current = await state(db, now, policy);
      return { ...current, inventoryError: error.message };
    }
  }
  return state(db, now, policy);
}

function measurementsPerDay(timing) {
  if (timing.type === "rules") return timing.rules.reduce((count, rule) => count + measurementsPerDay(rule), 0);
  if (timing.type === "daily") return timing.times.length;
  if (timing.type === "every-days") return 1 / timing.days;
  if (timing.type === "weekly") return timing.weekdays.length / 7;
  return 1440 / timing.minutes;
}

function previewSuite(input, current, policy) {
  const suite = normalizeSuite(input, current);
  const scope = members(suite, current.inventory);
  const nodes = scope.slice(0, 12).map(node => {
    const capacity = { measurementsPerDay: 0, samplesPerDay: 0, speedSecondsPerDay: 0, estimatedLightSecondsPerDay: 0 };
    const modules = suite.modules.filter(module => module.enabled).map(module => {
      const { jobs } = planRound(current, suite, module, node.uuid);
      const targets = jobs.map(job => {
        const missing = job.missingReason || (job.executor === "globalping" && !policy.globalping ?
          "公共 Globalping 测量未启用" : !current.workers[job.executor] &&
          !["bgp", "globalping"].includes(job.executor) ? "探测器尚未连接" : "");
        return { slotId: job.slotId, target: job.target, direction: job.direction, source: job.source, ready: !missing, reason: missing };
      });
      const count = jobs.filter(job => !job.missingReason).length * measurementsPerDay(module.timing);
      capacity.measurementsPerDay += count;
      if (["international", "idc", "tcp-quality"].includes(module.module)) {
        const variants = module.module === "tcp-quality" ? 1 + module.packetSizes.length : 1;
        capacity.samplesPerDay += count * module.samples * variants;
        capacity.estimatedLightSecondsPerDay += count * variants * 18;
      }
      if (module.module.endsWith("speed")) capacity.speedSecondsPerDay += count * 2 * (module.seconds + module.warmupSeconds) * module.streams.length;
      return { module: module.module, nextAt: module.nextAt, expected: targets.length, estimatedQueueSeconds: policy.idleSeconds, targets };
    });
    for (const key of Object.keys(capacity)) capacity[key] = Math.ceil(capacity[key]);
    return { uuid: node.uuid, name: node.name, modules, capacity };
  });
  return { suite, exceedsCapacity: nodes.some(node => node.capacity.measurementsPerDay > policy.dailyJobs || node.capacity.speedSecondsPerDay > 7200),
    nodes, totalNodes: scope.length };
}

async function publication(db, current, body, feature) {
  requireInput(current.revision === body.revision, "配置已变化，请刷新后保存", 409);
  requireInput(Array.isArray(body.nodeUuids) && body.nodeUuids.length <= 128 &&
    body.nodeUuids.every(id => current.inventory.some(node => node.uuid === id)), "发布节点无效");
  const ids = [...new Set(body.nodeUuids)];
  const config = await settings(db);
  let patch = {};
  if (feature === "routes") patch = { homeRouteNodes: ids, homeRouteDisplay: body.display !== false,
    homeRouteLabelMode: body.labelMode === "full" ? "full" : "preferred", homeRouteShowDetails: body.showDetails === true };
  else if (feature === "speeds") patch = { homeSpeedNodes: ids, homeSpeedDisplay: body.display !== false, homeSpeedShowDetails: body.showDetails === true };
  else {
    const section = body.section;
    requireInput(["traffic-reset", "ip-capability"].includes(section), "诊断栏目无效");
    const names = section === "traffic-reset" ? [section] : ["ip-quality", "media-unlock"];
    patch = { homeDiagnosticNodes: { ...current.homeDiagnosticNodes, ...Object.fromEntries(names.map(name => [name, ids])) },
      homeDiagnosticDisplay: { ...current.homeDiagnosticDisplay, ...Object.fromEntries(names.map(name => [name, body.display !== false])) },
      ipCapabilityExpanded: body.ipCapabilityExpanded ?? current.ipCapabilityExpanded ?? true };
  }
  return { revision: await writeSettings(db, cfgWith(config, patch), current.revision) };
}

export async function homeSummary(db, current, type, admin, now, liveServerIds) {
  const accessible = node => admin || node.publicVisible === true && liveServerIds.has(node.uuid);
  const available = new Set(current.inventory.filter(accessible).map(node => node.uuid));
  const speeds = type === "speeds";
  const published = (speeds ? current.homeSpeedNodes : current.homeRouteNodes || []) || [];
  const nodes = {}, diagnosticValues = {};
  const configuredFamilies = {};
  const moduleName = speeds ? "china-speed" : "routes";
  const configuredNodes = new Set(admin ? available : published.filter(id => available.has(id)));
  for (const suite of current.reportSuites.filter(suite => suite.enabled)) {
    for (const node of members(suite, current.inventory).filter(node => configuredNodes.has(node.uuid))) {
      const matching = suite.modules.filter(module => module.enabled && module.module === moduleName && ["4", "6"].includes(module.family));
      if (matching.length) configuredFamilies[node.uuid] = [...new Set([...(configuredFamilies[node.uuid] || []), ...matching.map(module => module.family)])];
    }
  }
  const ids = admin ? [...available] : published.filter(id => available.has(id));
  const diagnosticsIds = new Set(Object.values(current.homeDiagnosticNodes || {}).flat().filter(id => available.has(id)));
  const selected = [...new Set([...ids, ...(!speeds ? diagnosticsIds : [])])];
  const projectionRows = selected.length ? await db.all(`SELECT node,module,family,data FROM projections WHERE node IN (SELECT value FROM json_each(?))
    AND module IN (SELECT value FROM json_each(?))`, json(selected), json(speeds ? ["china-speed"] : ["routes", "ip-quality", "media-unlock"])) : [];
  for (const row of projectionRows) {
    const data = parse(row.data);
    if (row.module === "china-speed" && ids.includes(row.node)) {
      const node = nodes[row.node] ||= { "4": null, "6": null };
      node[row.family] = data;
    } else if (row.module === "routes" && ids.includes(row.node)) {
      const node = nodes[row.node] ||= { "4": [], "6": [] };
      const family = node[row.family];
      let carrier = family.find(item => item.carrier === data.carrier);
      if (!carrier) { carrier = { carrier: data.carrier, forward: null, return: null }; family.push(carrier); }
      carrier[data.direction] = { ...data.evidence, samples: 1 };
    } else if (!speeds && diagnosticsIds.has(row.node) && (current.homeDiagnosticNodes?.[row.module] || []).includes(row.node) &&
        current.homeDiagnosticDisplay?.[row.module] !== false && ["4", "6"].includes(row.family)) {
      const diagnostic = diagnosticValues[row.node] ||= {};
      const families = diagnostic[row.module] ||= {};
      families[row.family] = { ...data, providers: data.providers || {}, services: data.services || {},
        state: ["ok", "partial"].includes(data.state) ? data.state : "failed" };
    }
  }
  if (!speeds && current.homeDiagnosticDisplay?.["traffic-reset"] !== false) {
    for (const node of current.inventory.filter(node => available.has(node.uuid) && current.homeDiagnosticNodes?.["traffic-reset"]?.includes(node.uuid))) {
      const value = diagnosticValues[node.uuid] ||= {};
      value["traffic-reset"] = diagnostics.monitorResetCycle(node.resetDay, now);
    }
  }
  return { available: true, access: admin ? "admin" : "public", nodes, published: published.filter(id => available.has(id)),
    configuredFamilies, quickCheck: admin, quickFamilies: admin ? configuredFamilies : {},
    display: (speeds ? current.homeSpeedDisplay : current.homeRouteDisplay) !== false,
    showDetails: (speeds ? current.homeSpeedShowDetails : current.homeRouteShowDetails) === true,
    ...(speeds ? {} : { labelMode: current.homeRouteLabelMode || "preferred", diagnostics: diagnosticValues,
      ipCapabilityExpanded: current.ipCapabilityExpanded !== false }) };
}

function progress(round) {
  return { nodeUuid: round.nodeUuid, id: round.id, module: round.module, family: round.family, state: round.state,
    phase: round.completedAt ? "finished" : round.slots.some(slot => slot.state === "running") ? "running" : "queued",
    counts: round.counts, completedAt: round.completedAt, waitReason: round.completedAt ? "" : "等待探测器下次同步" };
}

export async function readShare(db, request, presented, now) {
  requireInput(/^[a-f0-9]{64}$/.test(presented), "分享已到期或撤销", 404);
  const key = await tokenHash(presented);
  const entry = await db.one(`SELECT r.id,r.node,s.expires_at FROM shares s JOIN rounds r ON s.round_id=r.id
    WHERE s.token_hash=? AND s.expires_at>? AND r.detail_available=1`, key, now);
  requireInput(entry, "分享已到期或撤销", 404);
  const round = await report(db, entry.node, entry.id, now);
  requireInput(round.detailAvailable, "报告明细已过期", 404);
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
  if (new URL(request.url).searchParams.get("format") === "json") return Response.json(round, { headers });
  return new Response(sharing.html(round, entry.expires_at, BASE + "/v3/shares/" + presented + "?format=json"), {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
  });
}

export async function administration(db, upstream, request, path, now, policy) {
  const [version, resource, id, action, roundId, subaction] = path;
  const method = request.method, url = new URL(request.url);
  if (version === "v3" && method === "GET" && resource === "capabilities" && !id) return capabilities;
  if (version === "v3" && method === "GET" && ["quota", "performance"].includes(resource) && !id) return quotaStatus(db, now, policy);
  if (resource === "nodes" && action === "rounds" && version === "v3") {
    if (method === "GET" && !roundId) return listReports(db, id, url, now);
    if (method === "GET" && roundId && !subaction) return report(db, id, roundId, now);
    if (method === "GET" && subaction === "original-images") {
      const round = await report(db, id, roundId, now);
      requireInput(round.detailAvailable && ["tcpquality-full", "nodequality-full"].includes(round.module), "原报告明细不可用或已过期", 404);
      try {
        return await originalAssets.collect(round.measurements[0]?.data?.reportUrl, round.module);
      } catch (error) {
        requireInput(false, error.message, 502);
      }
    }
    if (method === "POST" && subaction === "cancel") return cancelRound(db, id, roundId, now);
    if (method === "POST" && subaction === "share") {
      const round = await report(db, id, roundId, now, false);
      requireInput(round.completedAt && round.detailAvailable, "只能分享明细未过期且已收尾的报告");
      const secret = token(), hash = await tokenHash(secret);
      const expiresAt = Math.min(now + DETAIL_RETENTION, Date.parse(round.completedAt) + DETAIL_RETENTION);
      await db.change("INSERT INTO shares(token_hash,round_id,expires_at) VALUES(?,?,?)", hash, round.id, expiresAt);
      return { id: hash, expiresAt, url: BASE + "/v3/shares/" + secret };
    }
    if (method === "DELETE" && subaction === "shares") {
      await db.change("DELETE FROM shares WHERE round_id IN(SELECT id FROM rounds WHERE id=? AND node=?)", identifier(roundId), identifier(id));
      return { ok: true };
    }
    if (method === "DELETE" && roundId && !subaction) {
      const changed = await db.change("DELETE FROM rounds WHERE id=? AND node=? AND finished_at IS NOT NULL", identifier(roundId), identifier(id));
      requireInput(changed, "报告不存在或检测仍在运行", 409);
      return { ok: true };
    }
  }
  if (version === "v3" && method === "GET" && resource === "nodes" && action === "history-summary") return listReports(db, id, url, now, true);
  const current = await initialState(db, upstream, now, policy);
  const body = ["POST", "PUT"].includes(method) ? await readBody(request) : null;
  if (version === "v2") {
    if (method === "GET" && resource === "catalog" && !id) return { ...workerCatalog(current), inventoryError: current.inventoryError };
    if (resource === "nodes" && action === "token" && ["POST", "DELETE"].includes(method)) {
      const uuid = identifier(id);
      if (method === "DELETE") {
        await db.change("DELETE FROM workers WHERE id=?", "node:" + uuid);
        return { ok: true };
      }
      requireInput(current.inventory.some(node => node.uuid === uuid), "节点不存在，请确认 App 访问口令并刷新清单", 404);
      return { uuid, token: await registerWorker(db, "node:" + uuid, {}, policy.maxWorkers) };
    }
    if (resource === "probes" && method === "POST" && !id) {
      const uuid = body.id ? identifier(body.id) : crypto.randomUUID();
      requireInput(["电信", "联通", "移动", "其他"].includes(body.carrier) &&
        ["家庭宽带", "机房", "企业", "未知"].includes(body.accessType) && native.text(body.city) && native.text(body.name),
      "请完整填写测量点名称、城市、运营商与接入类型");
      const meta = { name: native.text(body.name), city: native.text(body.city), carrier: body.carrier, accessType: body.accessType,
        publicAddress: body.publicAddress ? native.host(body.publicAddress) : "", country: "CN" };
      return { id: uuid, token: await registerWorker(db, "probe:" + uuid, meta, policy.maxWorkers) };
    }
    if (resource === "probes" && method === "DELETE" && id) {
      await db.change("DELETE FROM workers WHERE id=?", "probe:" + identifier(id));
      return { ok: true };
    }
    if (resource === "workers" && method === "PUT" && ["node", "probe"].includes(id) && roundId === "update-policy") {
      requireInput(typeof body.enabled === "boolean", "自动更新偏好无效");
      const changed = await db.change("UPDATE workers SET updates=? WHERE id=?", Number(body.enabled), id + ":" + identifier(action));
      requireInput(changed, "探测器不存在", 404);
      return { ok: true };
    }
    if (resource === "endpoints" && method === "POST" && !id) {
      const uuid = identifier(body.nodeUuid), port = Number(body.port || 25201);
      requireInput(current.inventory.some(node => node.uuid === uuid), "节点不存在");
      requireInput(Number.isInteger(port) && port >= 20000 && port <= 40000, "测速端口需在 20000–40000");
      requireInput(!body.ipv4 || /^[0-9.]+$/.test(body.ipv4), "IPv4 地址无效");
      requireInput(!body.ipv6 || typeof body.ipv6 === "string" && body.ipv6.includes(":"), "IPv6 地址无效");
      const endpoint = { address: native.host(body.address || body.ipv4 || body.ipv6), port,
        ipv4: body.ipv4 ? native.host(body.ipv4) : "", ipv6: body.ipv6 ? native.host(body.ipv6) : "" };
      const raw = await settings(db);
      await writeSettings(db, cfgWith(raw, { endpoints: { ...raw.endpoints, [uuid]: endpoint } }), current.revision);
      return { ok: true };
    }
  }
  if (version === "v3") {
    if (method === "GET" && resource === "catalog" && !id) return reportCatalog(current, await quotaStatus(db, now, policy));
    if (method === "POST" && resource === "preview" && !id) return previewSuite(body, current, policy);
    if (resource === "suites" && method === "POST" && id && action === "run") {
      const suite = current.reportSuites.find(item => item.id === identifier(id) && item.enabled);
      requireInput(suite, "方案不存在或未启用", 404);
      return queueManual(db, current, suite, body.module, body.nodeUuids, now, policy);
    }
    if (resource === "suites" && (method === "POST" && !id || method === "DELETE" && id)) {
      const raw = await settings(db);
      if (method === "POST") {
        requireInput(body.revision === current.revision, "配置已变化，请刷新后保存", 409);
        const suite = normalizeSuite(body, current);
        const suites = [...raw.reportSuites.filter(item => item.id !== suite.id), suite];
        requireInput(suites.length <= 64, "免费版最多 64 个检测方案");
        const revision = await saveSuite(db, cfgWith(raw, { reportSuites: suites }), suite, current.revision, now);
        return { suite, revision };
      }
      const suite = current.reportSuites.find(item => item.id === identifier(id));
      requireInput(suite, "方案不存在", 404);
      const revision = await saveSuite(db, cfgWith(raw, { reportSuites: raw.reportSuites.filter(item => item.id !== suite.id) }),
        { ...suite, enabled: false }, current.revision, now);
      return { revision };
    }
    if (resource === "resources" && (method === "POST" && !id || method === "DELETE" && id)) {
      const raw = await settings(db);
      const saved = { ...raw, reportSecrets: { ...raw.reportSecrets } };
      if (method === "POST") {
        requireInput(body.revision === current.revision, "配置已变化，请刷新后保存", 409);
        const entry = resources.normalizeResource(body);
        const secret = body.token || (!body.clearToken && saved.reportSecrets[entry.id]);
        requireInput(!body.token || typeof body.token === "string" && /^[\x21-\x7e]{32,512}$/.test(body.token), "资源密钥需为 32–512 个可见 ASCII 字符");
        requireInput(!secret || entry.method !== "http" || entry.https, "有密钥的 HTTP 测速资源必须使用 HTTPS");
        saved.reportResources = [...saved.reportResources.filter(item => item.id !== entry.id), entry];
        requireInput(saved.reportResources.length <= 100, "自定义资源已达上限");
        if (secret) saved.reportSecrets[entry.id] = secret;
        else delete saved.reportSecrets[entry.id];
        return { resource: entry, revision: await writeSettings(db, saved, current.revision) };
      }
      requireInput(!raw.reportSuites.some(suite => suite.modules.some(module => module.endpoints.includes(id))), "请先从检测方案中移除此资源");
      saved.reportResources = saved.reportResources.filter(item => item.id !== id);
      delete saved.reportSecrets[id];
      return { revision: await writeSettings(db, saved, current.revision) };
    }
    if (["home-routes", "home-speeds", "home-diagnostics"].includes(resource)) {
      const feature = resource.slice(5);
      if (method === "PUT" && !id) return publication(db, current, body, feature);
      if (method === "GET" && !id && feature !== "diagnostics") return homeSummary(db, current, feature, true, now, new Set());
      if (method === "POST" && id === "rebuild" && feature !== "diagnostics") return { ok: true, ...await homeSummary(db, current, feature, true, now, new Set()) };
    }
    if (resource === "nodes" && action === "card-check" && method === "POST") {
      const uuid = identifier(id);
      requireInput(["routes", "china-speed"].includes(body.module) && ["4", "6"].includes(body.family), "卡片检测范围无效");
      const candidate = current.reportSuites.find(item => item.enabled &&
        members(item, current.inventory).some(node => node.uuid === uuid) &&
        item.modules.some(module => module.module === body.module && module.enabled && module.family === body.family));
      requireInput(candidate, "此 VPS 尚未配置对应的检测方案");
      const active = await db.one("SELECT id FROM rounds WHERE node=? AND suite=? AND module=? AND finished_at IS NULL", uuid, candidate.id, body.module);
      if (active) return progress(await report(db, uuid, active.id, now, false));
      const result = await queueManual(db, current, candidate, body.module, [uuid], now, policy);
      requireInput(result.rounds[0], "任务仍在排队或额度不足，请稍后重试", 409);
      return progress(await report(db, uuid, result.rounds[0], now, false));
    }
    if (resource === "card-checks" && id === "progress" && method === "POST") {
      requireInput(Array.isArray(body.checks) && body.checks.length <= 64, "检测进度范围无效");
      const checks = body.checks.map(check => ({ id: identifier(check?.id), nodeUuid: identifier(check?.nodeUuid) }));
      const rows = checks.length ? await db.all(`SELECT r.id,r.node,r.module,r.finished_at,json_extract(r.parameters,'$.family') AS family,
        SUM(j.state='ok' OR j.state='application') ok,SUM(j.state='partial') partial, SUM(j.state='failed') failed,
        SUM(j.state='missing') missing,SUM(j.state='cancelled') cancelled,SUM(j.state='running') running,COUNT(*) expected
        FROM rounds r JOIN jobs j ON j.round_id=r.id
        WHERE r.id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) GROUP BY r.id`, json(checks)) : [];
      return { checks: checks.map(check => {
        const row = rows.find(row => row.id === check.id && row.node === check.nodeUuid);
        if (!row) return { ...check, phase: "unavailable", state: "missing", counts: { expected: 0, completed: 0, ok: 0, partial: 0, failed: 0, missing: 0, cancelled: 0 } };
        const counts = { expected: row.expected, ok: row.ok, partial: row.partial, failed: row.failed, missing: row.missing, cancelled: row.cancelled,
          completed: row.ok + row.partial + row.failed + row.missing + row.cancelled };
        return { ...check, module: row.module, family: row.family, counts, phase: row.finished_at ? "finished" : row.running ? "running" : "queued",
          state: row.finished_at ? counts.ok === counts.expected ? "complete" : counts.ok || counts.partial ? "partial" : "failed" : "running",
          completedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null };
      }) };
    }
  }
  requireInput(false, "接口不存在", 404);
}
