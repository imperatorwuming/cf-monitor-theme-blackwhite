import model from "../plugin/src/model.js";

export const BASE = "/api/blackwhite-network-observatory";
export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const TRAFFIC_INTERVAL = 15 * MINUTE;
export const TRAFFIC_RETENTION = 45 * DAY;
export const DETAIL_RETENTION = 7 * DAY;
export const SUMMARY_RETENTION = 90 * DAY;
export const MAX_TARGETS = 48;
export const MAX_WORKERS = 60;
export const json = JSON.stringify;
export const parse = JSON.parse;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireInput(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

export function identifier(value) {
  requireInput(typeof value === "string" && model.UUID.test(value), "标识无效");
  return value.toLowerCase();
}

export function origin(value) {
  const url = new URL(value);
  requireInput(url.origin === value && (url.protocol === "https:" ||
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)), "服务地址必须是 origin");
  return url.origin;
}

export async function tokenHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function boundedSetting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export async function readBody(request, limit = 128_000) {
  if (!request.body) return {};
  requireInput(!(Number(request.headers.get("Content-Length")) > limit), "请求内容超出限制", 413);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "请求内容超出限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : await new Blob(chunks).arrayBuffer());
    const body = text ? parse(text) : {};
    requireInput(body && typeof body === "object" && !Array.isArray(body), "请求必须是 JSON 对象");
    return body;
  } catch {
    throw new HttpError(400, "请求必须是 JSON 对象");
  }
}

export function database(db) {
  const statement = (sql, ...params) => db.prepare(sql).bind(...params);
  return {
    statement,
    one: (sql, ...params) => statement(sql, ...params).first(),
    all: async (sql, ...params) => (await statement(sql, ...params).all()).results,
    change: async (sql, ...params) => (await statement(sql, ...params).run()).meta.changes,
    batch: (statements) => db.batch(statements),
  };
}

export function utcDay(now) {
  return Math.floor(now / DAY) * DAY;
}

// On Workers, redirects are returned as status responses and checked by the
// caller. The Node service retains its existing redirect-forbidden requests.
export function edgeFetch(input, init) {
  return fetch(input, { ...init, redirect: "manual" });
}
