CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '{}',
  seen_at INTEGER NOT NULL DEFAULT 0,
  session TEXT NOT NULL DEFAULT '',
  updates INTEGER NOT NULL DEFAULT 0,
  maintenance_until INTEGER NOT NULL DEFAULT 0,
  maintenance_id TEXT NOT NULL DEFAULT '',
  update_status TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS schedules (
  suite TEXT NOT NULL,
  module TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (suite, module)
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(due_at);

CREATE TABLE IF NOT EXISTS dispatch (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,
  module TEXT NOT NULL,
  planned_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  nodes TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  scheduled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dispatch_order ON dispatch(scheduled, created_at);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  node TEXT NOT NULL,
  suite TEXT NOT NULL,
  module TEXT NOT NULL,
  batch TEXT NOT NULL,
  planned_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  parameters TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  detail_available INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_round ON rounds(node, suite, module) WHERE finished_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_round_per_batch ON rounds(batch, node, module);
CREATE INDEX IF NOT EXISTS rounds_listing ON rounds(node, module, planned_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS rounds_expiration ON rounds(finished_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  executor TEXT NOT NULL,
  operation TEXT NOT NULL,
  slot TEXT NOT NULL,
  spec TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  summary TEXT,
  runtime TEXT
);
CREATE INDEX IF NOT EXISTS jobs_round ON jobs(round_id);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(executor, state, available_at);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs(lease_until) WHERE completed_at IS NULL AND lease_until IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS finish_round AFTER UPDATE OF completed_at ON jobs
WHEN NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL
BEGIN
  UPDATE rounds SET finished_at = NEW.completed_at WHERE id = NEW.round_id AND finished_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE round_id = NEW.round_id AND completed_at IS NULL);
END;

CREATE TABLE IF NOT EXISTS storage_meter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  result_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO storage_meter (id) VALUES (1);
CREATE TABLE IF NOT EXISTS results (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
);
CREATE INDEX IF NOT EXISTS results_expiration ON results(expires_at);
CREATE TRIGGER IF NOT EXISTS add_result_bytes AFTER INSERT ON results BEGIN
  UPDATE storage_meter SET result_bytes = result_bytes + NEW.bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS resize_result_bytes AFTER UPDATE OF bytes ON results BEGIN
  UPDATE storage_meter SET result_bytes = result_bytes + NEW.bytes - OLD.bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS remove_result_bytes AFTER DELETE ON results BEGIN
  UPDATE storage_meter SET result_bytes = result_bytes - OLD.bytes WHERE id = 1;
END;

CREATE TABLE IF NOT EXISTS shares (
  token_hash TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_round ON shares(round_id);
CREATE INDEX IF NOT EXISTS shares_expiration ON shares(expires_at);

CREATE TABLE IF NOT EXISTS traffic (
  node TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  source_at INTEGER NOT NULL,
  tx REAL NOT NULL,
  rx REAL NOT NULL,
  PRIMARY KEY (node, sampled_at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS traffic_expiration ON traffic(sampled_at);
CREATE TABLE IF NOT EXISTS maintenance (
  name TEXT PRIMARY KEY,
  ran_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_budget (
  day INTEGER PRIMARY KEY,
  jobs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projections (
  node TEXT NOT NULL,
  module TEXT NOT NULL,
  family TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (node, module, family, source)
);
CREATE INDEX IF NOT EXISTS projections_expiration ON projections(at);
