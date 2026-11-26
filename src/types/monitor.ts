export interface RealtimeDelta {
  sequence: number;
  snapshot: boolean;
  resync?: boolean;
  reports?: Record<string, unknown>;
  removed?: string[];
  online?: string[];
  offline?: string[];
}

export interface PingOverviewStat {
  name: string;
  total: number;
  lost: number;
  loss: number;
  min: number;
  max: number;
  avg: number;
  latest: number;
  tail: number;
}

export interface PingOverviewResult {
  from: string | number;
  to: string | number;
  tasks: Array<{ id: number; name: string; type: string; interval: number }>;
  stats: Record<string, Record<string, PingOverviewStat>>;
  series: Record<string, Record<string, Array<{
    time: string | number;
    value: number;
    sample_count: number;
    loss_count: number;
    loss: number;
  }>>>;
}
