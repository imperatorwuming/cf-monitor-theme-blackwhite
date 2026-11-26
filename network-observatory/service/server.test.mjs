import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createObservatory } from "./server.mjs";

const prefix = "/api/blackwhite-network-observatory";
const publicId = "00000000-0000-4000-8000-000000000001";
const hiddenId = "00000000-0000-4000-8000-000000000002";

test("CF sessions gate administration, worker credentials and archived traffic separately", async t => {
  const directory = mkdtempSync(join(tmpdir(), "blackwhite-service-test-"));
  let publicSite = true;
  const ts = Date.now() - 100;
  const rows = [
    { id: publicId, name: "Public", is_hidden: "0", last_updated: ts, net_rx: 20, net_tx: 40, reset_day: 1 },
    { id: hiddenId, name: "Hidden", is_hidden: "1", last_updated: ts, net_rx: 12, net_tx: 44, reset_day: 31 },
  ];
  const service = createObservatory({
    origin: "https://status.example.com",
    appPassword: "fixture-read",
    storageDir: directory,
    fetcher: async (url, init) => {
      const headers = new Headers(init.headers);
      const admin = headers.get("Authorization") === "Bearer admin-fixture";
      if (url.endsWith("/api/config")) return Response.json({ authorization: admin, is_public: publicSite });
      const hasAccess = admin || headers.get("X-App-Password") === "fixture-read";
      if (!publicSite && !hasAccess) return new Response(null, { status: 401 });
      return Response.json({ servers: hasAccess ? rows : rows.slice(0, 1) });
    },
  });
  service.http.listen(0, "127.0.0.1");
  await once(service.http, "listening");
  t.after(async () => {
    await new Promise(resolve => service.http.close(resolve));
    rmSync(directory, { force: true, recursive: true });
  });
  await service.tick();
  const url = "http://127.0.0.1:" + service.http.address().port + prefix;
  const admin = { Authorization: "Bearer admin-fixture", "Content-Type": "application/json" };
  const capability = await fetch(url + "/v3/capabilities", { headers: admin });
  assert.equal(capability.status, 200);
  assert.ok((await capability.json()).modules.includes("nodequality-full"));
  assert.equal((await fetch(url + "/v3/capabilities")).status, 401);
  assert.equal((await fetch(url + "/v3/capabilities", { headers: { ...admin, Origin: "https://untrusted.example.com" } })).status, 403);
  const tokenResponse = await fetch(url + "/v2/nodes/" + publicId + "/token", { method: "POST", headers: admin, body: "{}" });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();
  const heartbeat = await fetch(url + "/v2/workers/node/" + publicId + "/verify", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await fetch(url + "/v2/workers/node/" + publicId + "/update-policy", { headers: { Authorization: "Bearer " + token } })).status, 200);
  assert.equal((await fetch(url + "/v2/workers/node/" + publicId + "/update-policy", { method: "PUT", headers: { Authorization: "Bearer " + token } })).status, 401);

  const history = headers => fetch(url + "/v3/traffic-history", {
    method: "POST", headers,
    body: JSON.stringify({ ids: [publicId, hiddenId], start: ts - 5000, end: ts + 5000, points: 20 }),
  });
  const guest = await history({ "Content-Type": "application/json" });
  assert.deepEqual(await guest.json(), { [publicId]: [{ timestamp: ts, net_tx: 40, net_rx: 20 }] });
  const restricted = await history(admin);
  assert.deepEqual(Object.keys(await restricted.json()), [publicId, hiddenId]);
  publicSite = false;
  assert.equal((await history({ "Content-Type": "application/json" })).status, 403);
  assert.equal((await fetch(url + "/v3/public/routes")).status, 403);
});
