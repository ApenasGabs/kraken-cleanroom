CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error TEXT, llm_tokens_in INTEGER DEFAULT 0, llm_tokens_out INTEGER DEFAULT 0
);
CREATE TABLE phases (
  job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL,
  status TEXT NOT NULL, checkpoint_json TEXT, started_at TEXT, finished_at TEXT, stats_json TEXT,
  PRIMARY KEY (job_id, phase)
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
  phase TEXT NOT NULL, sha256 TEXT NOT NULL, blob_path TEXT, url TEXT, state_id TEXT,
  summary TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (job_id, kind, sha256)
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, module TEXT NOT NULL, category TEXT NOT NULL,
  statement TEXT NOT NULL, confidence TEXT NOT NULL, fingerprint TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL, UNIQUE (job_id, fingerprint)
);
CREATE TABLE rules (
  job_id TEXT NOT NULL, id TEXT NOT NULL, module TEXT NOT NULL, data_json TEXT NOT NULL,
  PRIMARY KEY (job_id, id)
);
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  message TEXT NOT NULL, live_url TEXT, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, ts TEXT NOT NULL,
  phase TEXT, type TEXT NOT NULL, data_json TEXT
);
CREATE INDEX idx_evidence_job_kind ON evidence(job_id, kind);
CREATE INDEX idx_events_job ON events(job_id, id);
