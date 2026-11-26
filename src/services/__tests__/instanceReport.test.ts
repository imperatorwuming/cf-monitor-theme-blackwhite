import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { readHistory, getPingRecords } = vi.hoisted(() => ({
  readHistory: vi.fn(), getPingRecords: vi.fn(),
}));
vi.mock("@/services/api", async original => ({
  ...await original<typeof import("@/services/api")>(), readHistory, getPingRecords, getTrafficArchive: async () => ({}),
}));
import { collectMetrics, collectPings, collectReportInput, normalizeReportMetrics, reportNode } from "@/services/instanceReport";
import { NodeInfoSchema, type NodeMetrics } from "@/types/komari";
const start = Date.parse("2026-01-01T00:00:00Z"), end = start + 3600000;
const range = { start, end, timeZone: "UTC" };
const meta = NodeInfoSchema.parse({ uuid: "a", name: "node" });
describe("CF-Server-Monitor report data", () => {
  beforeEach(() => {
    readHistory.mockReset().mockResolvedValue({ rows: [], max: 24, limited: false });
    getPingRecords.mockReset().mockResolvedValue({ records: [], tasks: [], from: start, to: end });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keeps offline status while rejecting placeholder counters without an actual report timestamp",()=>{
    const placeholder={online:false,updatedAt:0,uptime:0,trafficUp:0,trafficDown:0} as NodeMetrics;
    expect(reportNode(meta,placeholder).snapshot).toEqual({online:false,updatedAt:null,uptime:null,trafficUp:null,trafficDown:null});
    expect(reportNode(meta,{...placeholder,updatedAt:start,uptime:500,trafficUp:100}).snapshot).toEqual({online:false,updatedAt:start,uptime:500,trafficUp:100,trafficDown:0});
    expect(reportNode(meta).snapshot.online).toBeNull();
  });

  it("keeps zero values, skips absent fields and filters the exact report window", async () => {
    readHistory.mockResolvedValue({ rows: [{ timestamp: start, cpu: 0 }, { timestamp: start + 100, ram_used: 128 }, { timestamp: end, cpu: 10 }], max: 24, limited: false });
    const result = await collectMetrics("a", range, new AbortController().signal);
    expect(result.metrics.map(metric => metric.key)).toEqual(["cpu", "ram"]);
    expect(result.metrics[0].points).toEqual([{ t: start, v: 0 }, { t: start + 100, v: null }]);
    expect(result.metrics[1].points.at(-1)?.v).toBe(128 * 1024 ** 2);
    expect(normalizeReportMetrics({ records: [{ time: start, temp: -2 }] }, "a", range)[0].points[0].v).toBe(-2);
  });
  it("retains partial packet loss and advertises the permission window", async () => {
    getPingRecords.mockResolvedValue({ tasks: [], records: [{ time: start + 100, task_id: 1, value: 22, sample_count: 1, loss_count: .25 }], from: start + 10 });
    const result = await collectPings("a", range, new AbortController().signal);
    expect(result.pings[0].points[0]).toMatchObject({ v: 22, lost: .25, sent: 1 });
    expect(result.source.state).toBe("partial");
  });
  it("pages all network history, filters the exact range, and only makes read requests", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/capabilities"))
        return Response.json({
          schema: 3,
          modules: ["routes"],
          retention: { detailDays: 7, summaryDays: 90 },
        });
      if (path.includes("/rounds?"))
        return Response.json(
          path.includes("cursor=older")
            ? {
                rounds: [
                  {
                    id: "inside",
                    startedAt: new Date(start).toISOString(),
                    completedAt: new Date(end - 1).toISOString(),
                    detailAvailable: true,
                  },
                ],
                nextCursor: null,
              }
            : {
                rounds: [
                  {
                    id: "outside",
                    startedAt: new Date(start - 100000).toISOString(),
                    completedAt: new Date(start - 1000).toISOString(),
                  },
                ],
                nextCursor: "older",
              },
        );
      if (path.endsWith("/rounds/inside"))
        return Response.json({
          parameters: { family: "4" },
          slots: [],
          measurements: [
            {
              id: "m",
              nodeUuid: "a",
              target: "203.0.113.1",
              completedAt: new Date(end - 1).toISOString(),
              startedAt: new Date(start).toISOString(),
              direction: "VPS→目标",
              source: { name: "runner" },
              data: {
                state: "ok",
                hops: [{ ttl: 1, address: "203.0.113.1", token: "SECRET" }],
              },
            },
          ],
        });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await collectReportInput(
      {
        meta,
        range,
        theme: "light",
        showAddresses: false,
        compare: false,
        loggedIn: false,
      },
      new AbortController().signal,
      () => {},
    );
    expect(result.network).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("203.0.113.1");
    expect(
      fetcher.mock.calls.some(([path]) => path.includes("cursor=older")),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([path]) => path.includes("/rounds/outside")),
    ).toBe(false);
    for (const [, init] of fetcher.mock.calls as unknown as [
      string,
      RequestInit,
    ][])
      expect(init.method ?? "GET").toBe("GET");
  });
  it("keeps target-level route and speed summaries after raw files expire", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/capabilities")) return Response.json({ schema: 3, modules: ["routes", "china-speed"], retention: { detailDays: 7, summaryDays: 90 } });
      if (path.includes("history-summary")) {
        const speed = path.includes("china-speed");
        return Response.json({ rounds: [{ id: speed ? "speed" : "route", family: "6", plannedAt: new Date(start).toISOString(), completedAt: new Date(end - 1000).toISOString(), detailAvailable: false,
          slots: [{ id: "slot", state: "ok", completedAt: new Date(end - 1000).toISOString(), target: "203.0.113.5", direction: "VPS→大陆", source: { city: "上海", carrier: "电信", provider: "测试" },
            metrics: speed ? { runs: [{ state: "ok", streams: 1, vpsDirection: "download", bitsPerSecond: 250000000 }] } : { routeEvidence: { headlineLabels: ["CN2"] } } }] }], nextCursor: null });
      }
      return new Response("{}", { status: 404 });
    }));
    const result = await collectReportInput({ meta, range, theme: "light", showAddresses: false, compare: false, loggedIn: false }, new AbortController().signal, () => {});
    expect(result.network).toHaveLength(2);
    expect(result.network.every(e => e.summaryOnly && e.family === "6" && e.city === "上海")).toBe(true);
    expect(JSON.stringify(result.network)).toContain("CN2");
    expect(JSON.stringify(result.network)).toContain("250000000");
    expect(JSON.stringify(result)).not.toContain("203.0.113.5");
    expect(result.sources.find(s => s.id === "network-v3")?.state).toBe("partial");
  });
  it("continues the same module after a round becomes unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/capabilities")) return Response.json({ schema: 3, modules: ["routes"] });
      if (path.includes("history-summary")) return Response.json({ rounds: ["gone", "present"].map(id => ({ id, state: "complete", startedAt: new Date(start).toISOString(), completedAt: new Date(end - 1).toISOString(), detailAvailable: true })), nextCursor: null });
      if (path.endsWith("/rounds/present")) return Response.json({ slots: [], measurements: [{ id: "m", completedAt: new Date(end - 1).toISOString(), data: { state: "ok" } }] });
      return new Response("{}", { status: 404 });
    }));
    const result = await collectReportInput({ meta, range, theme: "light", showAddresses: false, compare: false, loggedIn: false }, new AbortController().signal, () => {});
    expect(result.network).toHaveLength(2);
    expect(result.network.some(e => e.id.includes("present"))).toBe(true);
    expect(result.network.find(e => e.id.includes("gone"))?.summaryOnly).toBe(true);
    expect(result.sources.find(s => s.id === "network-v3")?.detail).toContain("1 个轮次明细不可用");
  });
  it("marks summary-only data when retention expires between list and detail reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/capabilities")) return Response.json({ schema: 3, modules: ["routes"] });
      if (path.includes("history-summary")) return Response.json({ rounds: [{ id: "r", state: "complete", family: "4", startedAt: new Date(start).toISOString(), completedAt: new Date(end - 1).toISOString(), detailAvailable: true }], nextCursor: null });
      if (path.endsWith("/rounds/r")) return Response.json({ detailAvailable: false, slots: [{ id: "s", state: "ok", completedAt: new Date(end - 1).toISOString(), metrics: { routeEvidence: { headlineLabels: ["CN2"] } } }] });
      return new Response("{}", { status: 404 });
    }));
    const result = await collectReportInput({ meta, range, theme: "light", showAddresses: false, compare: false, loggedIn: false }, new AbortController().signal, () => {});
    expect(result.network[0]?.summaryOnly).toBe(true);
    expect(result.sources.find(s => s.id === "network-v3")?.state).toBe("partial");
  });
});
