import { fetchWithTimeout } from "@/utils/abort";

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly path: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function httpOrigin(value?: string) {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
      return url.origin;
    }
  } catch {
    // An invalid optional endpoint falls back to the current origin.
  }
  return "";
}

function meta(name: string) {
  return typeof document === "undefined" ? undefined : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
}

export function apiOrigins(): string[] {
  const page = typeof location === "undefined" ? "http://localhost" : location.origin;
  const configured = String(meta("apiBase") || import.meta.env.VITE_CFSM_API_BASE || "").split(",").map(httpOrigin).filter(Boolean);
  return [...new Set(configured.length ? configured : [page])];
}

export function adminUrl() {
  const origin = apiOrigins()[0];
  return (typeof location !== "undefined" && origin === location.origin ? "" : origin) + "/admin#/admin";
}

export function nativeAsset(path: string) {
  return (typeof location === "undefined" || apiOrigins()[0] === location.origin ? "" : apiOrigins()[0]) + path;
}

export function observatoryOrigin() {
  return httpOrigin(meta("blackwhiteObservatory") || import.meta.env.VITE_BLACKWHITE_OBSERVATORY) || apiOrigins()[0];
}

const readStorage = (key: string) => {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
};
export const browserToken = (origin: string) => (
  origin === apiOrigins()[0] ? readStorage("jwt_token") : readStorage(`blackwhite:jwt:${origin}`)
);

const verifiedByOrigin = new Map<string, string>();
const configCache = new Map<string, { key: string; expiry: number; request: Promise<CfConfig> }>();
const blocked = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeChallenge = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const challengePending = () => blocked.size > 0;
export const challengeOrigins = () => [...blocked];

function verified(origin: string) {
  return verifiedByOrigin.get(origin) ?? readStorage(origin === apiOrigins()[0] ? "turnstile_verified" : `blackwhite:turnstile:${origin}`);
}

export interface CfConfig {
  version?: string;
  site_title?: string;
  preferred_theme?: string;
  is_public: boolean;
  authorization: boolean;
  verified?: boolean;
  turnstile_enabled?: boolean;
  turnstile_site_key?: string;
  turnstile_verified?: string | null;
  theme_options?: Record<string, unknown>;
  frontend_ws_timeout_minutes?: number;
  latency_window?: { hours?: number; points?: number };
  [key: string]: unknown;
}

export function cfHeaders(origin: string, init?: HeadersInit, includeVerified = true) {
  const headers = new Headers(init);
  headers.set("Accept", "application/json");
  const token = browserToken(origin);
  if (token) headers.set("Authorization", "Bearer " + token);
  const proof = verified(origin);
  if (includeVerified && proof) headers.set("X-Turnstile-Verified", proof);
  return headers;
}

export async function cfRequest<T>(path: string, init: RequestInit = {}, origin = apiOrigins()[0], includeVerified = true): Promise<T> {
  const response = await fetchWithTimeout(origin + path, {
    ...init,
    cache: "no-store",
    credentials: "include",
    redirect: "error",
    headers: cfHeaders(origin, init.headers, includeVerified),
  }, 15_000, init.signal ?? undefined);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null) {
    if (response.status === 403 && /turnstile/i.test(String(payload?.error ?? payload?.message ?? ""))) {
      if (!blocked.has(origin)) {
        blocked.add(origin);
        notify();
      }
    }
    const message = payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
    throw new ApiRequestError(String(message), response.status, path);
  }
  return payload as T;
}

function fetchConfig(origin: string, token?: string) {
  return cfRequest<CfConfig>("/api/config", {
    headers: token ? { "X-Turnstile-Token": token } : undefined,
  }, origin, !token).catch(error => {
    if (token || !(error instanceof ApiRequestError) || error.status !== 403) throw error;
    verifiedByOrigin.set(origin, "");
    return cfRequest<CfConfig>("/api/config", {}, origin, false);
  }).then(config => {
    if (typeof config.is_public !== "boolean" || typeof config.authorization !== "boolean") {
      throw new Error("CF-Server-Monitor 站点配置格式无效");
    }
    if (config.turnstile_verified) {
      verifiedByOrigin.set(origin, config.turnstile_verified);
      try {
        localStorage.setItem(origin === apiOrigins()[0] ? "turnstile_verified" : `blackwhite:turnstile:${origin}`, config.turnstile_verified);
      } catch { /* Session memory still holds the proof. */ }
    }
    if (config.turnstile_enabled && !config.verified) {
      if (!blocked.has(origin)) {
        blocked.add(origin);
        notify();
      }
    } else if (blocked.delete(origin)) {
      notify();
    }
    return config;
  });
}

export function getCfConfig(origin = apiOrigins()[0], fresh = false) {
  const key = browserToken(origin) + "\n" + verified(origin);
  const cached = configCache.get(origin);
  if (!fresh && cached?.key === key && Date.now() < cached.expiry) return cached.request;
  const request = fetchConfig(origin).catch(error => {
    if (configCache.get(origin)?.request === request) configCache.delete(origin);
    throw error;
  });
  configCache.set(origin, { key, expiry: Date.now() + 20_000, request });
  return request;
}

export async function verifyChallenge(origin: string, token: string) {
  const config = await fetchConfig(origin, token);
  if (!config.verified) throw new Error("验证未通过，请重试。");
  configCache.delete(origin);
}

export function observatoryFetch(path: string, init: RequestInit = {}, timeout = 30_000, signal?: AbortSignal) {
  const origin = observatoryOrigin();
  const backend = apiOrigins()[0];
  return fetchWithTimeout(origin + path, {
    ...init,
    credentials: origin === backend ? "include" : "omit",
    redirect: "error",
    headers: cfHeaders(backend, init.headers),
  }, timeout, signal ?? init.signal ?? undefined);
}
