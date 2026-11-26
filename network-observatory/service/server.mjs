import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import controller from "../plugin/src/native-controller.js";
import { trafficArchive } from "./traffic.mjs";
import { createCredentialStore, jsonResponse, readBody } from "./state.mjs";

const BASE = "/api/blackwhite-network-observatory";
const DOWNLOAD = BASE + "/downloads/";
const assets = fileURLToPath(new URL("../../release/runner", import.meta.url));
const workerPath = /^\/(?:v2\/workers\/(?:node|probe)|v1\/nodes)\/[^/]+\/(?:verify|heartbeat|poll|result|maintenance|update-policy)$/;
const sharePath = /^\/v3\/shares\/[a-f0-9]{64}$/;
const publicPath = /^\/v3\/public\/(?:routes|speeds)$/;
const downloadPath = /^Blackwhite-Network-Observatory-(?:install\.sh|(?:latest|v\d+\.\d+\.\d+)\.zip)(?:\.sha256)?$/;

function monitorOrigin(value) {
  const url = new URL(value);
  if ((!["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CFSM_ORIGIN 必须是 Worker 的完整 origin");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("CFSM_ORIGIN 必须使用 HTTPS");
  }
  return url.origin;
}

function compile(path) {
  const parts = path.split("/");
  return pathname => {
    const match = pathname.split("/");
    return match.length === parts.length && parts.every((part, index) => part.startsWith(":") ? !!match[index] : part === match[index]);
  };
}

export function createObservatory({
  origin, appPassword = "", storageDir, origins = [], fetcher = fetch, downloadDir = assets,
}) {
  const cf = monitorOrigin(origin);
  const allow = new Set([cf, ...origins.map(monitorOrigin)]);
  const routes = [];
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const store = createCredentialStore(storageDir);
  const traffic = trafficArchive(storageDir);

  async function cfJson(path, headers = {}) {
    const response = await fetcher(cf + path, { headers, signal: AbortSignal.timeout(10_000), redirect: "error" });
    return { ok: response.ok, data: response.ok ? await response.json() : {} };
  }

  async function inventory() {
    const result = await cfJson("/api/servers", appPassword ? { "X-App-Password": appPassword } : {});
    if (!result.ok || !Array.isArray(result.data.servers)) throw new Error("无法读取 CF-Server-Monitor 节点清单，请检查 App 访问口令。");
    traffic.capture(result.data.servers);
    return result.data.servers.filter(row => typeof row?.id === "string").map(row => ({
      uuid: row.id,
      name: row.name,
      group: row.server_group,
      hidden: [true, 1, "1", "true"].includes(row.is_hidden),
      resetDay: Number(row.reset_day),
    }));
  }

  const server = {
    route(method, path, handle) { routes.push({ method, match: compile(path), handle }); },
    call(method) {
      if (method !== "admin:listClients") throw new Error("未知的节点清单操作");
      return inventory();
    },
  };
  const worker = controller.registerNativeController({
    server,
    storageDir,
    ...store,
    respond: jsonResponse,
    readBody,
    authorized(req, res) {
      if (req.isAdmin) return true;
      jsonResponse(res, 401, { error: "需要 CF-Server-Monitor 管理员登录" });
      return false;
    },
  });

  function monitorHeaders(req, includeCredentials) {
    const headers = new Headers();
    const verify = req.headers["x-turnstile-verified"];
    if (typeof verify === "string") headers.set("X-Turnstile-Verified", verify);
    if (includeCredentials) {
      if (req.headers.authorization) headers.set("Authorization", req.headers.authorization);
      const cookie = req.headers.cookie?.split(";").find(value => value.trimStart().startsWith("cfsm_auth="));
      if (cookie) headers.set("Cookie", cookie.trimStart());
    }
    return headers;
  }

  async function readRequest(req, res, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) {
        res.setHeader("Connection", "close");
        jsonResponse(res, 413, { error: "请求内容超出限制" });
        return false;
      }
      chunks.push(chunk);
    }
    req.body = Buffer.concat(chunks);
    return true;
  }

  const listener = async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      if (!allow.has(requestOrigin)) return jsonResponse(res, 403, { error: "来源未授权" });
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }

    try {
      const url = new URL(req.url, "http://localhost");
      const { pathname } = url;
      if (req.method === "GET" && pathname === BASE + "/health") return jsonResponse(res, 200, { ok: true });
      if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith(DOWNLOAD)) {
        const filename = pathname.slice(DOWNLOAD.length);
        if (!downloadPath.test(filename)) return jsonResponse(res, 404, { error: "找不到发布文件" });
        const file = await readFile(resolve(downloadDir, filename)).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!file) return jsonResponse(res, 404, { error: "请先构建探测器发布包" });
        res.setHeader("Content-Type", filename.endsWith(".zip") ? "application/zip" : "text/plain; charset=utf-8");
        res.setHeader("Content-Length", file.length);
        res.end(req.method === "HEAD" ? undefined : file);
        return;
      }
      if (!pathname.startsWith(BASE + "/")) return jsonResponse(res, 404, { error: "接口不存在" });
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Turnstile-Verified");
        res.setHeader("Access-Control-Max-Age", "600");
        res.writeHead(204).end();
        return;
      }

      if (req.method === "POST" && pathname === BASE + "/v3/traffic-history") {
        if (!await readRequest(req, res, 16_384)) return;
        let request;
        try { request = readBody(req); } catch { return jsonResponse(res, 400, { error: "流量查询格式无效" }); }
        const { ids, start, end, points } = request || {};
        if (!Array.isArray(ids) || ids.length > 128 ||
          ids.some(id => typeof id !== "string" || !/^[\w.:-]{1,64}$/.test(id)) ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end ||
          !Number.isInteger(points) || points < 2 || points > 2000) {
          return jsonResponse(res, 400, { error: "流量查询参数无效" });
        }
        const allowed = await cfJson("/api/servers", monitorHeaders(req, true));
        if (!allowed.ok || !Array.isArray(allowed.data.servers)) return jsonResponse(res, 403, { error: "无权访问流量历史" });
        const visible = new Set(allowed.data.servers.map(row => row.id));
        const safeIds = [...new Set(ids)].filter(id => visible.has(id));
        return jsonResponse(res, 200, traffic.read(safeIds, start, end, points));
      }

      const route = routes.find(item => item.method === req.method && item.match(pathname));
      if (!route) return jsonResponse(res, 404, { error: "接口不存在" });
      const suffix = pathname.slice(BASE.length);
      const runner = workerPath.test(suffix) && (suffix.endsWith("/update-policy") ? req.method === "GET" : req.method === "GET" || req.method === "POST");
      if (publicPath.test(suffix)) {
        const sessionInfo = await cfJson("/api/config", monitorHeaders(req, false));
        if (!sessionInfo.ok || sessionInfo.data.is_public !== true || (sessionInfo.data.turnstile_enabled && !sessionInfo.data.verified)) {
          return jsonResponse(res, 403, { error: "当前站点未开放网络观测数据" });
        }
      } else if (!runner && !sharePath.test(suffix)) {
        if (!req.headers.authorization && !req.headers.cookie) {
          return jsonResponse(res, 401, { error: "需要 CF-Server-Monitor 管理员登录" });
        }
        const sessionInfo = await cfJson("/api/config", monitorHeaders(req, true));
        if (!sessionInfo.ok || sessionInfo.data.authorization !== true) {
          return jsonResponse(res, 401, { error: "管理员会话无效" });
        }
        if (sessionInfo.data.turnstile_enabled && !sessionInfo.data.verified) {
          return jsonResponse(res, 403, { error: "需要通过 Turnstile 验证" });
        }
        req.isAdmin = true;
      }

      if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
        const limit = runner && suffix.endsWith("/result") ? 1_000_000 : 131_072;
        if (!await readRequest(req, res, limit)) return;
      }
      await route.handle(req, res);
    } catch (error) {
      if (!res.headersSent) jsonResponse(res, 502, { error: "网络观测服务无法完成请求" });
      else res.destroy();
      if (error?.name !== "AbortError") console.error("Observatory request failed", error?.name);
    }
  };

  const http = createServer({ requestTimeout: 35_000 }, listener);
  http.once("close", () => traffic.close());
  return { http, tick: worker.tick };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const env = process.env;
  const service = createObservatory({
    origin: env.CFSM_ORIGIN,
    appPassword: env.CFSM_APP_PASSWORD,
    storageDir: resolve(env.BLACKWHITE_DATA_DIR || "network-observatory/data"),
    origins: (env.BLACKWHITE_ALLOWED_ORIGINS || "").split(",").map(item => item.trim()).filter(Boolean),
  });
  service.http.listen(Number(env.BLACKWHITE_PORT || 8788), env.BLACKWHITE_HOST || "127.0.0.1", () => {
    console.log("Blackwhite Observatory", service.http.address());
    void service.tick();
  });
  const timer = setInterval(() => void service.tick(), 60_000);
  const stop = () => {
    clearInterval(timer);
    service.http.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
