import { join } from "node:path";
import state from "../plugin/src/json-state.js";

export function createCredentialStore(directory) {
  const isMissingFile = error => error?.code === "ENOENT";
  const credentials = state.jsonState(join(directory, "state.json"), isMissingFile, () => ({ nodes: {} }), value => {
    if (!value?.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)) throw new Error("探测器凭证状态格式无效");
    return { nodes: value.nodes };
  });
  return { isMissingFile, readState: credentials.read, writeState: credentials.write };
}

export function jsonResponse(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

export function readBody(req) {
  if (!req.body?.length) throw new Error("请求内容为空");
  return JSON.parse(req.body.toString("utf8"));
}
