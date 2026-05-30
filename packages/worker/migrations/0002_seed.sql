-- Bootstrap one workspace, its plans, and example channel tags.
-- created_at uses SQLite strftime millis (acceptable for fixtures).
-- settings is a literal JSON string (unambiguous boolean for delete_discord_original_message).

INSERT INTO workspaces (id, name, owner_id, channel_type, billing_day, settings, created_at, updated_at)
VALUES (
  1, '社團 AI 訂閱', 'poterpan5466@gmail.com', 'discord', 5,
  '{"timezone":"Asia/Taipei","discord_guild_id":"","discord_billing_channel_id":"","discord_payment_message_id":"","overdue_days":3,"delete_discord_original_message":false,"proof_retention_months":24}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO plans (workspace_id, name, provider, monthly_amount, created_at, updated_at) VALUES
  (1, 'ChatGPT',         'openai',    315,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, 'Claude Standard', 'anthropic', 251,  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, 'Claude Premium',  'anthropic', 1258, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT INTO channel_tags (workspace_id, name, type, sort_order, created_at) VALUES
  (1, 'LINE Pay',      'linepay', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  (1, '銀行轉帳-國泰', 'bank',    2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
