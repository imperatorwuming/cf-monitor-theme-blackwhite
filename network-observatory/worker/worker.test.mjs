import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHandler } from "./index.mjs";
import { BASE, DAY, MINUTE } from "./common.mjs";

const nodeOne = "6509351f-f62b-479f-8690-847580be1830";
const nodeTwo = "29612ba0-132d-40f9-b3d1-3a96fc12665e";
const admin = "admin-session-fixture";
const frontend = "https://monitor.example.com";
const worker = "https://observatory.example.com";
const initialTime = Date.UTC(2026, 10, 27, 15);

function fixture(t, vars = {}) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(readFileSync(new URL("./migrations/0001_observatory.sql", import.meta.url), "utf8"));
  // An asynchronous D1-shaped wrapper over SQLite. The same migrations and
  // Worker bundle are additionally exercised with Wrangler for deployment.
  const DB = {
    prepare(sql) {
      return { bind(...values) {
        const stmt = database.prepare(sql);
        return {
          first: async () => stmt.get(...values) || null,
          all: async () => ({ results: stmt.all(...values) }),
          run: () => ({ meta: { changes: stmt.run(...values).changes } }),
        };
      } };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const values = statements.map(stmt => stmt.run());
        database.exec("COMMIT");
        return values;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = { DB, CFSM_ORIGIN: frontend, CFSM_APP_PASSWORD: "password-fixture", ...vars };
  let now = initialTime, turnstile = true, publicSite = true, twoHidden = true, calls = 0;
  const upstream = async req => {
    calls++;
    const path = new URL(req.url).pathname;
    const authorized = req.headers.get("Authorization") === "Bearer " + admin;
    const app = req.headers.get("X-App-Password") === env.CFSM_APP_PASSWORD;
    const verified = req.headers.get("X-Turnstile-Verified") === "verified-fixture";
    if (path === "/api/config") return Response.json({ authorization: authorized, is_public: publicSite, turnstile_enabled: turnstile, verified });
    assert.equal(path, "/api/servers");
    if (!app && (!publicSite || turnstile) && !verified) return Response.json({}, { status: 403 });
    const server = (id, hidden) => ({ id, name: hidden ? "Hidden" : "Test", is_hidden: hidden, server_group: "Test",
      ip_v4: "203.0.113.1", net_tx: 60, net_rx: 40, last_updated: now, reset_day: 10 });
    const servers = [server(nodeOne, false), ...(app || authorized || !twoHidden ? [server(nodeTwo, twoHidden)] : [])];
    return Response.json({ servers });
  };
  let handler = createHandler({ clock: () => now, fetcher: upstream });
  async function call(path, { method = "GET", body, auth = admin, origin = frontend, verified = true, expected = 200 } = {}) {
    const headers = {};
    if (auth) headers.Authorization = "Bearer " + auth;
    if (origin) headers.Origin = origin;
    if (verified) headers["X-Turnstile-Verified"] = "verified-fixture";
    if (body) headers["Content-Type"] = "application/json";
    const result = await handler.fetch(new Request(worker + BASE + path, { method, headers, body: body && JSON.stringify(body) }), env);
    const isJson = result.headers.get("Content-Type")?.includes("application/json");
    const payload = isJson ? await result.json() : await result.text();
    assert.equal(result.status, expected, JSON.stringify(payload));
    return { result, payload };
  }
  return { call, database, env, now: () => now, at: value => { now = value; },
    hide: value => { twoHidden = value; }, visibility: value => { publicSite = value; },
    cron: () => handler.scheduled({ scheduledTime: now }, env),
    restart: () => { handler = createHandler({ clock: () => now, fetcher: upstream }); },
    upstreamCalls: () => calls };
}

const role = (node = nodeOne) => "/v2/workers/node/" + node;
const heartbeat = (instance, extra = {}) => ({ instanceId: instance, version: "1.1.0", tools: ["mtr"], features: ["report-v3"], ...extra });
const draft = (revision, node = nodeOne) => ({ revision, name: "Test plan", clients: [node], modules: [
  { module: "international", endpoints: ["aws:ap-northeast-1"], timing: { type: "interval", minutes: 60 }, family: "4" },
] });
const smallResult = { kind: "latency", state: "failed", diagnostic: "Fixture: no route",
  tcpQuality: { method: "TCP connect", address: "", state: "unavailable", sent: 0, received: 0,
    failurePercent: null, avgMs: null, minMs: null, maxMs: null, stdevMs: null, samples: [] } };

async function setupPlan(call, node = nodeOne, source = draft) {
  const { payload: catalog } = await call("/v3/catalog");
  assert.ok(Array.isArray(catalog.endpoints));
  assert.ok(Array.isArray(catalog.presets));
  const { payload: enrolled } = await call("/v2/nodes/" + node + "/token", { method: "POST", body: {} });
  const { payload: saved } = await call("/v3/suites", { method: "POST", body: source(catalog.revision, node) });
  return { ...saved, token: enrolled.token };
}

test("Cloudflare flow verifies admin, leases once, accepts retries after restart, and revokes shares", async t => {
  const f = fixture(t);
  const { call } = f;
  await call("/health", { auth: "", origin: "" });
  await call("/v3/catalog", { auth: "", expected: 401 });
  await call("/v3/catalog", { verified: false, expected: 403 });
  await call("/v3/catalog", { origin: "https://wrong.example.com", expected: 403 });
  const { result: cors } = await call("/v3/catalog", { method: "OPTIONS", auth: "", expected: 204 });
  assert.equal(cors.headers.get("Access-Control-Allow-Origin"), frontend);
  const { suite, token, revision } = await setupPlan(call);
  await call("/v3/suites", { method: "POST", body: draft(revision - 1), expected: 409 });
  const { payload: verify } = await call(role() + "/verify", { method: "POST", body: {}, auth: token });
  assert.equal(verify.sync, true);
  assert.equal(verify.minSyncSeconds, 300);
  const instance = "a".repeat(32), otherInstance = "b".repeat(32);
  const { payload: idle } = await call(role() + "/sync", { method: "POST", body: heartbeat(instance), auth: token });
  assert.equal(idle.task, null);
  assert.equal(idle.nextSyncSeconds, 300);
  const { payload: launched } = await call("/v3/suites/" + suite.id + "/run", { method: "POST", body: {}, expected: 202 });
  assert.equal(launched.rounds.length, 1);
  const id = launched.rounds[0];
  const first = await call(role() + "/sync", { method: "POST", body: heartbeat(instance), auth: token });
  assert.ok(first.payload.task);
  assert.equal(first.payload.task.target, "sts.ap-northeast-1.amazonaws.com");
  assert.equal(first.payload.nextSyncSeconds, 30);
  const competing = await call(role() + "/sync", { method: "POST", body: heartbeat(otherInstance), auth: token });
  assert.equal(competing.payload.task, null);
  const idempotent = await call(role() + "/sync", { method: "POST", body: heartbeat(instance), auth: token });
  assert.equal(idempotent.payload.task.id, first.payload.task.id);
  const during = await call("/v3/nodes/" + nodeOne + "/rounds/" + id);
  assert.equal(during.payload.state, "running");

  const resultPath = role() + "/result";
  const result = { id: first.payload.task.id, instanceId: instance, data: smallResult };
  await call(resultPath, { method: "POST", auth: token, body: { ...result, instanceId: otherInstance }, expected: 409 });
  f.restart();
  const deliveries = await Promise.all([1, 2].map(() => call(resultPath, { method: "POST", auth: token, body: result })));
  assert.equal(deliveries.filter(value => !value.payload.replay).length, 1);
  assert.equal(deliveries.every(value => value.payload.detailStored), true);
  const roundPath = "/v3/nodes/" + nodeOne + "/rounds/" + id;
  const { payload: report } = await call(roundPath);
  assert.equal(report.state, "failed");
  assert.equal(report.measurements.length, 1);
  assert.equal(report.measurements[0].data.diagnostic, smallResult.diagnostic);
  const { payload: share } = await call(roundPath + "/share", { method: "POST", body: {} });
  const publicPath = share.url.slice(BASE.length);
  const { result: shared, payload: html } = await call(publicPath, { auth: "", origin: "" });
  assert.match(html, /<!doctype html>/i);
  assert.match(shared.headers.get("Content-Security-Policy"), /default-src 'none'/);
  const after = await call(publicPath + "?format=json", { auth: "", origin: "" });
  assert.equal(after.payload.id, report.id);
  await call(roundPath + "/shares", { method: "DELETE" });
  await call(publicPath, { auth: "", origin: "", expected: 404 });
  await call("/v2/nodes/" + nodeOne + "/token", { method: "DELETE" });
  await call(role() + "/sync", { method: "POST", auth: token, body: heartbeat(instance), expected: 401 });
});

test("cron preserves traffic visibility, deduplicates time buckets and resumes after UTC budget rollover", async t => {
  const f = fixture(t, { BLACKWHITE_DAILY_JOBS: "1" });
  const { call } = f;
  const { suite, token } = await setupPlan(call);
  await f.cron();
  const traffic = { ids: [nodeOne, nodeTwo], start: f.now() - MINUTE, end: f.now() + MINUTE, points: 10 };
  const requester = await call("/v3/traffic-history", { method: "POST", body: traffic, auth: "" });
  assert.equal(requester.payload[nodeOne].length, 1);
  assert.equal(Object.hasOwn(requester.payload, nodeTwo), false);
  const visible = await call("/v3/traffic-history", { method: "POST", body: traffic });
  assert.equal(visible.payload[nodeTwo].length, 1);

  f.at(initialTime + 61 * MINUTE);
  await f.cron();
  const rounds = async () => (await call("/v3/nodes/" + nodeOne + "/rounds?module=international")).payload.rounds;
  assert.equal((await rounds()).length, 1);
  await f.cron();
  assert.equal((await rounds()).length, 1);
  const { payload: quota } = await call("/v3/quota");
  assert.equal(quota.mode, "paused");
  assert.equal(quota.trafficIntervalMinutes, 30);
  await call("/v3/suites/" + suite.id + "/run", { method: "POST", body: {}, expected: 429 });
  const instance = "c".repeat(32);
  const { payload } = await call(role() + "/sync", { method: "POST", body: heartbeat(instance), auth: token });
  assert.ok(payload.task);
  f.at(f.now() + 4 * MINUTE);
  await f.cron();
  assert.equal((await rounds())[0].state, "failed");
  await call(role() + "/result", { method: "POST", body: { id: payload.task.id, instanceId: instance, data: smallResult }, auth: token, expected: 409 });

  f.at(initialTime + DAY);
  await f.cron();
  assert.equal((await rounds()).length, 2);
  assert.equal((await call("/v3/quota")).payload.jobs, 1);
});

test("private data stays out of public projections and downloads stay on the release allowlist", async t => {
  const f = fixture(t);
  const { call } = f;
  f.hide(false);
  const { payload: source } = await call("/v3/catalog");
  await call("/v3/home-diagnostics", { method: "PUT", body: { section: "traffic-reset", display: true, nodeUuids: [nodeTwo], revision: source.revision } });
  const first = await call("/v3/public/routes", { auth: "" });
  assert.ok(first.payload.diagnostics[nodeTwo]);
  f.hide(true); // The cached snapshot is still public, but the live CF API is authoritative.
  const hidden = await call("/v3/public/routes");
  assert.equal(hidden.payload.diagnostics[nodeTwo], undefined);
  f.visibility(false);
  await call("/v3/public/routes", { auth: "", expected: 403 });
  await call("/v3/traffic-history", { method: "POST", auth: "", verified: false,
    body: { ids: [nodeOne], start: f.now() - MINUTE, end: f.now(), points: 5 }, expected: 403 });

  const { result: redirect } = await call("/downloads/Blackwhite-Network-Observatory-latest.zip.sha256",
    { auth: "", origin: "", expected: 302 });
  assert.match(redirect.headers.get("Location"), /^https:\/\/github\.com\/imperatorwuming\/cf-monitor-theme-blackwhite\/releases\/download\/v/);
  await call("/downloads/no.txt", { auth: "", origin: "", expected: 404 });
});

test("rolls back oversized report details without dropping summary and permits maintenance only when idle", async t => {
  const f = fixture(t, { BLACKWHITE_RESULT_KIB: "32" });
  const { call } = f;
  const custom = (revision, node) => ({ revision, name: "Full report", clients: [node], modules: [
    { module: "tcpquality-full", family: "4", timing: { type: "interval", minutes: 1440 }, timeoutMinutes: 30 },
  ] });
  const { suite, token } = await setupPlan(call, nodeOne, custom);
  const v = (await call("/v2/catalog")).payload.runnerRelease.version;
  const instance = "d".repeat(32);
  const path = role() + "/maintenance";
  const prevent = await call(path, { method: "POST", auth: token, body: { action: "claim", version: v } });
  await call(path, { method: "POST", auth: token, body: { action: "release", lease: "0".repeat(32) }, expected: 409 });
  await call(path, { method: "POST", auth: token, body: { action: "release", lease: prevent.payload.lease, state: "ok" } });
  const { payload: started } = await call("/v3/suites/" + suite.id + "/run", { method: "POST", body: {}, expected: 202 });
  const { payload: assigned } = await call(role() + "/sync", { method: "POST", body: heartbeat(instance, { features: ["report-v3", "tcpquality-full"] }), auth: token });
  assert.equal(assigned.task.operation, "tcpquality-full");
  await call(path, { method: "POST", auth: token, body: { action: "claim", version: v }, expected: 409 });
  f.at(f.now() + 10 * MINUTE);
  const update = await call(role() + "/sync", { method: "POST", body: heartbeat(instance, { activeJobIds: [assigned.task.id], allowTask: false }), auth: token });
  assert.deepEqual(update.payload.activeJobIds, [assigned.task.id]);
  const full = { id: assigned.task.id, instanceId: instance, data: { kind: "tcpquality-full", state: "ok", cleanLog: "x".repeat(48_000) } };
  const receipt = await call(role() + "/result", { method: "POST", auth: token, body: full });
  assert.equal(receipt.payload.detailStored, false);
  const roundPath = "/v3/nodes/" + nodeOne + "/rounds/" + started.rounds[0];
  const outcome = await call(roundPath);
  assert.equal(outcome.payload.detailAvailable, false);
  assert.equal(outcome.payload.state, "complete");
  assert.equal(outcome.payload.measurements.length, 0);
  await call(roundPath + "/share", { method: "POST", body: {}, expected: 400 });
  assert.equal((await call("/v3/quota")).payload.storedBytes, 0);
});

test("fifty idle probes can synchronize without a heartbeat write for every connection", async t => {
  const f = fixture(t);
  const { call, database } = f;
  await call("/v3/catalog");
  const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
  const insert = database.prepare("INSERT INTO nodes(id,data) VALUES (?,?)");
  for (const id of ids) insert.run(id, JSON.stringify({ uuid: id, name: id, group: "Test", publicVisible: false, ip: "" }));
  const tokens = await Promise.all(ids.map(id => call("/v2/nodes/" + id + "/token", { method: "POST", body: {} }).then(value => value.payload.token)));
  const synchronize = () => Promise.all(ids.map((id, index) => call(role(id) + "/sync", { method: "POST", body: heartbeat("e".repeat(32)), auth: tokens[index] })));
  const responses = await synchronize();
  assert.ok(responses.every(({ payload }) => payload.task === null && payload.nextSyncSeconds === 300));
  f.at(f.now() + 5 * MINUTE);
  await synchronize();
  assert.equal(database.prepare("SELECT MAX(seen_at) seen FROM workers").get().seen, initialTime);
  const quota = (await call("/v3/quota")).payload;
  assert.equal(quota.workers, 50);
  assert.equal(quota.estimatedIdleRequestsPerDay, 14_400);
});

test("controlled speed stage waits for the listener and the credentials go only to the assigned probe", async t => {
  const f = fixture(t);
  const { call } = f;
  const { payload: point } = await call("/v2/probes", { method: "POST",
    body: { name: "Fixture", city: "北京", carrier: "电信", accessType: "机房" } });
  const speed = (revision, node) => ({ revision, name: "Controlled", clients: [node], trafficAccepted: true, modules: [
    { module: "china-speed", endpoints: [], sources: [point.id], family: "4", timing: { type: "interval", minutes: 1440 } },
  ] });
  const { suite, token } = await setupPlan(call, nodeOne, speed);
  const probe = "/v2/workers/probe/" + point.id;
  const a = "a".repeat(32), b = "b".repeat(32);
  const status = { authScheme: "oaep", tools: ["openssl", "iperf3"] };
  await call(probe + "/sync", { method: "POST", body: heartbeat(b, status), auth: point.token });
  await call("/v3/suites/" + suite.id + "/run", { method: "POST", body: {}, expected: 202 });
  assert.equal((await call(probe + "/sync", { method: "POST", body: heartbeat(b, status), auth: point.token })).payload.task, null);
  const { payload: { task: listener } } = await call(role() + "/sync", { method: "POST", body: heartbeat(a, status), auth: token });
  assert.equal(listener.operation, "listen");
  assert.equal(listener.options.lifetime, 600);
  const publicKey = "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----";
  await call(role() + "/result", { method: "POST", auth: token,
    body: { id: listener.id, instanceId: a, data: { state: "ready", publicKey, scheme: "oaep" } } });
  const { payload: { task: benchmark } } = await call(probe + "/sync", { method: "POST", body: heartbeat(b, status), auth: point.token });
  assert.equal(benchmark.operation, "benchmark");
  assert.equal(benchmark.credentials.password, listener.options.password);
  assert.equal(benchmark.credentials.publicKey, publicKey);
  const saved = await call(probe + "/result", { method: "POST", auth: point.token,
    body: { id: benchmark.id, instanceId: b, data: { kind: "speed", state: "failed", diagnostic: "fixture" } } });
  assert.equal(saved.payload.detailStored, true);
  const finished = await call("/v3/nodes/" + nodeOne + "/rounds/" + benchmark.roundId);
  assert.equal(finished.payload.measurements.length, 1);
  assert.equal(JSON.stringify(finished.payload).includes(listener.options.password), false);
});

test("a same-account service binding receives the existing CF session and Turnstile headers", async t => {
  const f = fixture(t);
  const reached = [];
  f.env.CFSM = {
    async fetch(request) {
      reached.push(new URL(request.url).pathname);
      if (request.headers.get("Authorization") !== "Bearer " + admin) return Response.json({}, { status: 401 });
      return Response.json({ authorization: true, is_public: false, turnstile_enabled: true,
        verified: request.headers.get("X-Turnstile-Verified") === "verified-fixture" });
    },
  };
  await f.call("/v3/capabilities");
  await f.call("/v3/capabilities", { verified: false, expected: 403 });
  assert.deepEqual(reached, ["/api/config", "/api/config"]);
  assert.equal(f.upstreamCalls(), 0);
});
