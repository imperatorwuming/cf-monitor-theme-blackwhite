const MODULES = [
  "routes",
  "tcp-quality",
  "tcpquality-full",
  "nodequality-full",
  "ip-quality",
  "media-unlock",
  "china-speed",
  "international",
  "idc",
  "international-speed",
  "bgp",
];
const TERMINAL = [
  "ok",
  "partial",
  "application",
  "failed",
  "missing",
  "cancelled",
];
function summarize(round) {
  const counts = {
    expected: round.slots.length,
    completed: 0,
    ok: 0,
    partial: 0,
    failed: 0,
    missing: 0,
    cancelled: 0,
  };
  for (const slot of round.slots) {
    if (TERMINAL.includes(slot.state)) counts.completed++;
    if (slot.state === "application") counts.ok++;
    else if (Object.prototype.hasOwnProperty.call(counts, slot.state))
      counts[slot.state]++;
  }
  const done = counts.completed === counts.expected;
  const state = !done
    ? "running"
    : counts.cancelled === counts.expected && counts.expected
      ? "cancelled"
      : counts.ok === counts.expected && counts.expected
        ? "complete"
        : counts.ok + counts.partial
          ? "partial"
          : counts.missing === counts.expected
            ? "missing"
            : "failed";
  return {
    id: round.id,
    nodeUuid: round.nodeUuid,
    module: round.module,
    family: round.parameters?.family,
    suiteId: round.suiteId,
    batchId: round.batchId,
    plannedAt: round.plannedAt,
    startedAt: round.startedAt,
    completedAt: round.completedAt || null,
    state,
    counts,
    schema: 3,
    detailAvailable: round.detailAvailable !== false,
  };
}

function metrics(data) {
  const value = {
    kind: data.kind,
    state: data.state,
    method: data.method,
    toolVersion: data.toolVersion,
    protocol: data.protocol,
    family: data.family,
    resolvedIp: data.resolvedIp,
    warmupSeconds: data.warmupSeconds,
    actualEndpoint: data.actualEndpoint,
    routeEvidence: data.routeEvidence,
    synProbes: data.synProbes,
  };
  if (data.kind === "ip-quality") Object.assign(value, { providers: data.providers, riskScores: data.riskScores,
    ipMode: data.ipMode, dbIpScore: data.dbIpScore, diagnostic: data.diagnostic });
  if (data.kind === "media-unlock") Object.assign(value, { services: data.services, mediaEvidence: data.mediaEvidence, diagnostic: data.diagnostic });
  if (data.tcpQuality)
    Object.assign(value, {
      address: data.tcpQuality.address,
      medianMs: data.tcpQuality.medianMs,
      received: data.tcpQuality.received,
      sent: data.tcpQuality.sent,
    });
  if (data.hops)
    Object.assign(value, {
      hops: data.hops.length,
      complete: data.complete,
      asPath: data.hops.map((h) => h.asn || "?"),
    });
  if (data.runs)
    value.runs = data.runs.map((r) => ({
      state: r.state,
      measurementBasis: r.measurementBasis,
      intervalSource: r.intervalSource,
      remoteIp: r.remoteIp,
      streams: r.streams,
      vpsDirection: r.vpsDirection,
      bitsPerSecond: r.bitsPerSecond,
      maxBitsPerSecond: r.maxBitsPerSecond,
      tcpRttMs: r.tcpRttMs,
      retransmits: r.retransmits,
      bytes: r.bytes,
      seconds: r.seconds,
      trafficBytesObserved: r.trafficBytesObserved,
      congestionControl: r.congestionControl,
      tcpRttMethod: r.tcpRttMethod,
      tcpSampleSide: r.tcpSampleSide,
    }));
  if (data.prefix)
    Object.assign(value, {
      prefix: data.prefix,
      originAsns: data.originAsns,
      rpki: data.rpki,
      sources: data.sources,
    });
  return value;
}

module.exports = { MODULES, TERMINAL, summarize, metrics };
