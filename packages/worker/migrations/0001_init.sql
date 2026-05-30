-- ChipPot D1 schema v2. Conventions: timestamps = UTC ISO millis TEXT;
-- business dates = YYYY-MM-DD (Asia/Taipei); period = YYYY-MM; amounts = INTEGER TWD;
-- booleans = INTEGER + CHECK (col IN (0,1)).

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('discord','line','telegram')),
  billing_day INTEGER NOT NULL DEFAULT 5 CHECK (billing_day BETWEEN 1 AND 28),
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  discord_id TEXT,
  display_name TEXT NOT NULL,
  email TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, discord_id)
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  monthly_amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD' CHECK (currency = 'TWD'),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  split_count INTEGER,
  discord_role_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  type TEXT CHECK (type IN ('linepay','bank','other')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  start_date TEXT NOT NULL,
  billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  custom_cycle INTEGER NOT NULL DEFAULT 0 CHECK (custom_cycle IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','verified','rejected')),
  has_proof INTEGER NOT NULL DEFAULT 0 CHECK (has_proof IN (0,1)),
  screenshot_key TEXT,
  proof_deleted_at TEXT,
  payment_note TEXT,
  verified_channel_tag_id INTEGER REFERENCES channel_tags(id),
  source TEXT NOT NULL DEFAULT 'user'
    CHECK (source IN ('user','user_slash','user_web','admin_manual','cron')),
  rejected_reason TEXT,
  submitted_at TEXT,
  paid_at TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subscription_id, period)
);

CREATE TABLE upload_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  subscription_id INTEGER REFERENCES subscriptions(id),
  used_at TEXT,
  used_by_source TEXT,
  revoked_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Dedup columns are NOT NULL DEFAULT 0 (sentinel) because SQLite treats NULLs as
-- distinct in UNIQUE, which would defeat dedup. See roadmap deviation §4.1.
CREATE TABLE notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('billing_opened','overdue','receipt')),
  period TEXT NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  subscription_id INTEGER NOT NULL DEFAULT 0,
  external_channel_type TEXT,
  external_message_id TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_payments_workspace_period_status
  ON payments(workspace_id, period, status);
CREATE INDEX idx_payments_subscription_period
  ON payments(subscription_id, period);
CREATE INDEX idx_subscriptions_workspace_status
  ON subscriptions(workspace_id, status);
CREATE INDEX idx_users_workspace ON users(workspace_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(workspace_id, entity_type, entity_id);
