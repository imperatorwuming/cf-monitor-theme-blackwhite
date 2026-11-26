import { describe, expect, it } from "vitest";
import { resolveHistoryWindow } from "@/services/api";
import { dashboardPingRows, HOUR, loadPoint, MIB, nodeInfo, pingPoints, realtimePoint } from "@/services/cfMetrics";

describe("CF-Server-Monitor adapter", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const publicConfig = { is_public: true, authorization: false };
  it("selects supported windows and marks partial requests for anonymous users", () => {
    expect(resolveHistoryWindow(2, undefined, publicConfig, now)).toMatchObject({ window: 6, from: now - 2 * HOUR, limited: false });
    expect(resolveHistoryWindow(72, undefined, publicConfig, now)).toMatchObject({ window: 24, from: now - 24 * HOUR, limited: true });
    expect(resolveHistoryWindow(2, { start: now - 60 * HOUR, end: now - 58 * HOUR }, { ...publicConfig, authorization: true }, now)).toMatchObject({ window: 96, to: now - 58 * HOUR, limited: false });
  });

  it("converts MiB, billing and traffic units without treating public reachability as an IP", () => {
    const row = { ram_total: "8192", price: "0", billing_cycle: "two_years", traffic_limit: "500", traffic_calc_type: "ul", ip_v4: "1", last_updated: now, cpu: 9, tcp_conn: 8, udp_conn: 2, net_tx_monthly: 0, net_tx: 23 };
    expect(nodeInfo(row, "id")).toMatchObject({ mem_total: 8192 * MIB, ipv4: "", ipv4_reachable: true, price: -1, billing_cycle: "730", traffic_limit: 500 * 1024 ** 3, traffic_limit_type: "up" });
    expect(loadPoint({ ...row, timestamp: now, ram_used: 12 }, "id")).toMatchObject({ ram: 12 * MIB, connections: 8, connections_udp: 2 });
    expect(realtimePoint(row, "id", now)).toMatchObject({ online: true, monthly_up: 0, net_total_up: 23 });
    expect(realtimePoint(row, "id", now + 300_000)?.online).toBe(false);
  });

  it("distinguishes disabled probes, timeout and partial packet loss", () => {
    const records = pingPoints({ ping_ct: "false", ping_cu: null, loss_cu: 100, ping_node_1: 12, loss_node_1: 10 }, "id", 0, now);
    expect(records.map(record => [record.task_id, record.value, record.loss_rate])).toEqual([[2, -1, 1], [5, 12, .1]]);
    expect(dashboardPingRows({ ping: [{ ts: now, ct: 17 }], loss: [{ ts: now, ct: 5 }] })).toEqual([{ timestamp: now, ping_ct: 17, loss_ct: 5 }]);
  });
});
