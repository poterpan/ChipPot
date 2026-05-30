-- Defense in depth (Codex review finding 2): a screenshot_key must map to at most one
-- payment, so a colliding upload can never be silently attached to another payment's row.
-- Server-generated random keys already make collisions practically impossible; this makes
-- it impossible. Partial index excludes NULL (deleted/never-uploaded) keys.
CREATE UNIQUE INDEX idx_payments_screenshot_key
  ON payments(screenshot_key) WHERE screenshot_key IS NOT NULL;
