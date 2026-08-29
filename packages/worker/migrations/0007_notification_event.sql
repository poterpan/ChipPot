-- Receipt (審核結果回條) and nudge (個別催繳) notifications need a 'nudge' type that the
-- CHECK constraint does not yet allow.
--
-- This migration runs AFTER 0006_overdue_daily.sql, which already added the `event` column,
-- rebuilt the table and put `event` in the UNIQUE. So this rebuild changes ONE thing: the type
-- CHECK gains 'nudge'. SQLite cannot ALTER a CHECK constraint, hence the table rebuild.
--
-- `event` now carries three different meanings, one per type:
--   * overdue        — the Taipei business date (#48 daily reminders: one message per day)
--   * receipt        — 'reject' / 'verify' (退回 and 確認 are separate events on one bill)
--   * billing_opened — '' (the whole-entity slot)
--   * nudge          — '' (the whole-entity slot)
--
-- CRITICAL: the INSERT below carries `event` across verbatim. Writing '' here would silently
-- wipe the live day-keys that 0006 put in production, degrading #48's daily reminders back to
-- one-per-period with no error anywhere.
-- notification_logs has no foreign keys in either direction, so a plain rebuild is safe.
CREATE TABLE notification_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('billing_opened','overdue','receipt','nudge')),
  period TEXT NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  subscription_id INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL DEFAULT '',
  external_channel_type TEXT,
  external_message_id TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id, event)
);

INSERT INTO notification_logs_new
  (id, workspace_id, type, period, plan_id, user_id, subscription_id, event,
   external_channel_type, external_message_id, sent_at)
SELECT id, workspace_id, type, period, plan_id, user_id, subscription_id, event,
       external_channel_type, external_message_id, sent_at
FROM notification_logs;

DROP TABLE notification_logs;
ALTER TABLE notification_logs_new RENAME TO notification_logs;
