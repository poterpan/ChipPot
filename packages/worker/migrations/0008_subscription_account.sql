-- 附卡 (#58): one payer can hold several accounts, each its own subscription. The payer still
-- receives every bill / reminder; these columns only tell the subscriptions apart.
--
--   account_label — short public tag shown next to the plan name everywhere a member-facing line
--                   is rendered, Discord included (e.g. "方案 A（帳號 2）").
--   account_email — the account's mailbox. Admin-only: never rendered in Discord, since overdue
--                   reminders are posted in a public channel.
--
-- A subscription with either column set is an extra account (附卡): roster import never touches
-- it (no skip/reactivate/pause), so it is managed by hand in 後台.
ALTER TABLE subscriptions ADD COLUMN account_label TEXT;
ALTER TABLE subscriptions ADD COLUMN account_email TEXT;
