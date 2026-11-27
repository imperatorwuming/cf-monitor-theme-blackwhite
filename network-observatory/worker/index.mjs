import release from "../plugin/src/runner-release.json" with { type: "json" };
import { BASE, HttpError, database, readBody, requireInput } from "./common.mjs";
import { monitor, trafficHistory } from "./monitor.mjs";
import { administration, homeSummary, readShare } from "./admin.mjs";
import { probeRoute } from "./probes.mjs";
import { quotaPolicy, runSchedule, settings, state } from "./schedule.mjs";
import { cleanReports, expireJobs } from "./reports.mjs";

const releaseFiles = new Set(["Blackwhite-Network-Observatory-install.sh", "Blackwhite-Network-Observatory-latest.zip", release.archive]);
const releases = "https://github.com/imperatorwuming/cf-monitor-theme-blackwhite/releases/download/";

function decorate(response, requestOrigin) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  if (requestOrigin) {
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return new Response(response.body, { status: response.status, headers });
}

export function createHandler({ clock = Date.now, fetcher = fetch, providers } = {}) {
  async function fetchRequest(request, env) {
    let corsOrigin = "";
    try {
      const upstream = monitor(env, fetcher);
      const requestOrigin = request.headers.get("Origin");
      if (requestOrigin) {
        requireInput(upstream.allowed.has(requestOrigin), "来源未授权", 403);
        corsOrigin = requestOrigin;
      }
      const db = database(env.DB);
      const url = new URL(request.url);
      requireInput(url.pathname.startsWith(BASE + "/"), "接口不存在", 404);
      const path = url.pathname.slice(BASE.length + 1).split("/").map(decodeURIComponent);
      const [version, resource, role, id, operation] = path;
      const method = request.method;
      const policy = quotaPolicy(env);
      const now = clock();
      let result;
      let status = 200;
      if (method === "OPTIONS") {
        result = new Response(null, { status: 204, headers: {
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Turnstile-Verified, X-Turnstile-Token",
          "Access-Control-Max-Age": "600",
        } });
      } else if (version === "health" && path.length === 1 && method === "GET") {
        const row = await db.one("SELECT id FROM settings WHERE id=1");
        requireInput(row, "请先初始化 D1 数据库", 503);
        result = { ok: true, mode: "serverless-free" };
      } else if (version === "downloads" && path.length === 2 && ["GET", "HEAD"].includes(method)) {
        requireInput(releaseFiles.has(resource.replace(/\.sha256$/, "")), "找不到发布文件", 404);
        result = Response.redirect(releases + release.releaseTag + "/" + resource, 302);
      } else if (version === "v2" && resource === "workers" && ["node", "probe"].includes(role) && path.length === 5 &&
        ((["sync", "verify", "result", "heartbeat", "maintenance"].includes(operation) && method === "POST") ||
         (["poll", "update-policy"].includes(operation) && method === "GET"))) {
        result = await probeRoute(db, request, role, id, operation, now, policy, () => settings(db), release);
      } else if (version === "v3" && resource === "shares" && path.length === 3 && method === "GET") {
        result = await readShare(db, request, role, now);
      } else if (version === "v3" && resource === "public" && ["routes", "speeds"].includes(role) && path.length === 3 && method === "GET") {
        await upstream.session(request, false);
        const live = new Set((await upstream.list(request, false)).map(row => row.id.toLowerCase()));
        result = await homeSummary(db, await state(db, now, policy), role, false, now, live);
      } else if (version === "v3" && resource === "traffic-history" && path.length === 2 && method === "POST") {
        result = await trafficHistory(db, upstream, request, await readBody(request, 16_384), now);
      } else {
        requireInput(["v2", "v3"].includes(version), "接口不存在", 404);
        await upstream.session(request, true);
        result = await administration(db, upstream, request, path, now, policy);
        if (resource === "suites" && operation === undefined && id && path.at(-1) === "run") status = 202;
      }
      return decorate(result instanceof Response ? result : Response.json(result, { status }), corsOrigin);
    } catch (error) {
      if (error instanceof HttpError) {
        return decorate(Response.json({ error: error.message }, { status: error.status,
          headers: error.status === 429 ? { "Retry-After": "300" } : {} }), corsOrigin);
      }
      if (error instanceof URIError) return decorate(Response.json({ error: "请求地址无效" }, { status: 400 }), corsOrigin);
      const limited = /quota|limit|SQLITE_FULL/i.test(error.message);
      console.error("Blackwhite Worker request failed", error.name, limited ? "capacity" : "internal");
      return decorate(Response.json({ error: limited ? "Cloudflare 额度或存储暂不可用，请稍后重试" : "网络观测服务暂不可用" },
        { status: limited ? 503 : 500, headers: limited ? { "Retry-After": "300" } : {} }), corsOrigin);
    }
  }

  async function scheduled(event, env) {
    const db = database(env.DB), now = event.scheduledTime || clock();
    const upstream = monitor(env, fetcher);
    await expireJobs(db, now);
    await cleanReports(db, now);
    await runSchedule(db, upstream, now, quotaPolicy(env), providers);
  }

  return { fetch: fetchRequest, scheduled };
}

export default createHandler();
