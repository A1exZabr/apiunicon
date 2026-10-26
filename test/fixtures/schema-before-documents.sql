CREATE TABLE IF NOT EXISTS documentation_sources (
  id TEXT PRIMARY KEY,
  root_url TEXT NOT NULL,
  allowed_origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'crawling', 'ready', 'failed')),
  content_fingerprint TEXT,
  error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documentation_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES documentation_sources(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(source_id, content_hash)
);

CREATE VIRTUAL TABLE IF NOT EXISTS documentation_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  source_id UNINDEXED,
  heading,
  body
);

CREATE TABLE IF NOT EXISTS adapters (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  documentation_source_id TEXT NOT NULL REFERENCES documentation_sources(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'reusable')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'working', 'failed')),
  version INTEGER NOT NULL CHECK (version >= 1),
  dsl_json TEXT NOT NULL,
  documentation_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_sets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_fields (
  credential_set_id TEXT NOT NULL REFERENCES credential_sets(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  PRIMARY KEY (credential_set_id, field_name)
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  adapter_id TEXT REFERENCES adapters(id),
  documentation_source_id TEXT NOT NULL REFERENCES documentation_sources(id),
  allowed_origins_json TEXT NOT NULL,
  credential_set_id TEXT NOT NULL REFERENCES credential_sets(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_drafts (
  id TEXT PRIMARY KEY,
  documentation_source_id TEXT NOT NULL UNIQUE REFERENCES documentation_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('discovering','needs_review','needs_help','ready','failed','completed')),
  service_name TEXT,
  suggested_label TEXT,
  discovery_json TEXT NOT NULL,
  selected_origins_json TEXT,
  selected_credentials_json TEXT,
  error_category TEXT,
  completed_connection_id TEXT REFERENCES connections(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_events (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  operation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('constraint', 'pagination', 'auth', 'error_mapping', 'behavior')),
  finding_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_audits (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  adapter_id TEXT NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  adapter_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_category TEXT,
  adapter_changed INTEGER NOT NULL CHECK (adapter_changed IN (0, 1))
);

CREATE TABLE IF NOT EXISTS adapter_test_outcomes (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL REFERENCES adapters(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  adapter_version INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  http_status INTEGER,
  error_category TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_credentials (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('crawl_documentation')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS tunnel_config (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  runtime_credential_set_id TEXT NOT NULL REFERENCES credential_sets(id),
  profile_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_configured', 'stopped', 'starting', 'healthy', 'failed')),
  last_error_category TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnel_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info', 'error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documentation_chunks_source ON documentation_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_connections_adapter ON connections(adapter_id);
CREATE INDEX IF NOT EXISTS idx_connection_drafts_status ON connection_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_adapter ON knowledge_events(adapter_id);
CREATE INDEX IF NOT EXISTS idx_execution_audits_connection ON execution_audits(connection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_adapter_test_outcomes_adapter ON adapter_test_outcomes(adapter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_web_sessions_token ON web_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tunnel_events_created ON tunnel_events(created_at DESC);
