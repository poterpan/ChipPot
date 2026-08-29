-- #48 每日催繳: the overdue reminder's dedup slot is keyed on (workspace, period, DAY) so the
-- daily cron keeps reminding every day until the period has no unpaid bills left, instead of
-- exactly once per period. The 'event' column carries the Taipei business date for overdue rows;
-- it is '' for every other notification type, which is exactly the old whole-entity slot.
-- SQLite cannot ALTER a table-level UNIQUE, so the table is rebuilt. notification_logs has no
-- foreign keys in either direction, so a plain rebuild is safe.
CREATE TABLE notification_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('billing_opened','overdue','receipt')),
  period TEXT NOT NULL,
  plan_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  subscription_id INTEGER NOT NULL DEFAULT 0,
  -- '' = the whole-entity slot (billing_opened / receipt). Overdue rows carry the YYYY-MM-DD
  -- business date the reminder was sent, so one message is allowed per day, per period.
  event TEXT NOT NULL DEFAULT '',
  external_channel_type TEXT,
  external_message_id TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id, event)
);

INSERT INTO notification_logs_new
  (id, workspace_id, type, period, plan_id, user_id, subscription_id, event,
   external_channel_type, external_message_id, sent_at)
SELECT id, workspace_id, type, period, plan_id, user_id, subscription_id, '',
       external_channel_type, external_message_id, sent_at
FROM notification_logs;

DROP TABLE notification_logs;
ALTER TABLE notification_logs_new RENAME TO notification_logs;
