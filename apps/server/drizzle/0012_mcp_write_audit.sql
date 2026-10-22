-- M3 受控写入：一次性确认令牌与追加式审计。
-- 只保存参数哈希、目标与结果摘要，不保存正文、原始令牌或绝对路径。

CREATE TABLE IF NOT EXISTS mcp_write_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL,
  requirement_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_write_confirmations_expires_idx
  ON mcp_write_confirmations(expires_at);

CREATE TABLE IF NOT EXISTS mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool TEXT NOT NULL,
  requirement_id INTEGER,
  target_type TEXT,
  target_id TEXT,
  params_hash TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  confirmation_id INTEGER REFERENCES mcp_write_confirmations(id),
  actor_name TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('prepared', 'success', 'error')),
  error_code TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_audit_requirement_created_idx
  ON mcp_audit(requirement_id, created_at DESC);
