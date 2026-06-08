import { applyD1Migrations, env } from "cloudflare:test";

// Scrub external secrets that a local `.dev.vars` would otherwise inject (CI has none), so the
// test baseline is identical on every machine. Tests that exercise outbound calls set their own
// dummy token + stub fetch; leaving a real token here would make those paths hit Discord for real
// locally while CI takes the no-send branch. Keep in sync with outbound-gated secrets.
delete (env as { DISCORD_BOT_TOKEN?: string }).DISCORD_BOT_TOKEN;

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
