import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DAY = 86400_000;
const RETENTION = 45 * DAY;

export function trafficArchive(directory) {
  const db = new DatabaseSync(join(directory, "traffic.sqlite"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS traffic (
      id TEXT NOT NULL, ts INTEGER NOT NULL, tx REAL NOT NULL, rx REAL NOT NULL,
      PRIMARY KEY (id, ts)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS traffic_retention ON traffic(ts);
  `);
  const insert = db.prepare("INSERT OR REPLACE INTO traffic(id,ts,tx,rx) VALUES (?,?,?,?)");
  const prune = db.prepare("DELETE FROM traffic WHERE ts < ?");
  const select = db.prepare(`
    WITH sampled AS (
      SELECT MIN(ts) AS ts FROM traffic WHERE id = ? AND ts BETWEEN ? AND ?
      GROUP BY (ts - ?) / ?
    ), boundary AS (
      SELECT MAX(ts) AS ts FROM traffic WHERE id = ? AND ts BETWEEN ? AND ?
    )
    SELECT ts AS timestamp, tx AS net_tx, rx AS net_rx
    FROM traffic WHERE id = ? AND ts IN (
      SELECT ts FROM sampled UNION SELECT ts FROM boundary
    ) ORDER BY ts
  `);
  let lastPrune = 0;

  return {
    capture(servers, now = Date.now()) {
      db.exec("BEGIN");
      try {
        for (const row of servers) {
          if (!row || typeof row.id !== "string" || row.net_tx == null || row.net_rx == null) continue;
          const ts = Number(row.last_updated), tx = Number(row.net_tx), rx = Number(row.net_rx);
          if (Number.isSafeInteger(ts) && ts >= now - RETENTION && ts <= now + 60_000 &&
            Number.isFinite(tx) && tx >= 0 && Number.isFinite(rx) && rx >= 0) {
            insert.run(row.id, ts, tx, rx);
          }
        }
        if (now - lastPrune > DAY) prune.run(now - RETENTION);
        db.exec("COMMIT");
        if (now - lastPrune > DAY) lastPrune = now;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    read(ids, requestedStart, requestedEnd, pointLimit, now = Date.now()) {
      const start = Math.max(Math.trunc(requestedStart), now - RETENTION);
      const end = Math.min(Math.trunc(requestedEnd), now);
      if (end <= start) return {};
      const step = Math.max(1, Math.ceil((end - start + 1) / (pointLimit - 1)));
      return Object.fromEntries(ids.map(id => [id, select.all(id, start, end, start, step, id, start, end, id)]));
    },
    close() { db.close(); },
  };
}
