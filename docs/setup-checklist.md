# ChipPot — Inputs I need from you (fill in, then I wire it up)

You're resting; I'll keep building everything that doesn't need these. The items below are
the things only you can provide. **Secrets** (marked 🔒) should go into a gitignored file
`packages/worker/.dev.vars` (one `KEY=value` per line) — NOT committed, NOT pasted in chat
if you can avoid it. Non-secret IDs are fine to paste in chat.

Legend: ⛔ = blocks finishing that phase · 🟡 = optional / has a sensible default.

---

## A. Hosting URLs — choose one (🟡, default needs nothing from you)

I can ship entirely on **free Cloudflare URLs** (no domain/DNS needed):
- Worker API: `chippot.<your-workers-subdomain>.workers.dev`
- Upload page: `chippot-web.pages.dev`
- Admin UI: `chippot-admin.pages.dev` (still protected by Access)

- [x] **Use free *.pages.dev / *.workers.dev** (default — leave blank), **OR**
- [ ] **Use my custom domain:** `__________________` (apex/zone, e.g. `club.example.org`)
      - desired upload subdomain: `pay.____________`  · admin subdomain: `admin.____________`

## B. Cloudflare API token (🟡 strongly recommended for unattended Access/Pages/DNS)

wrangler is already logged in (works for Workers/D1/R2). But configuring **Access** and
possibly **Pages/DNS** unattended may exceed the interactive login's scopes. To let me do
it all without prompts, create a token and put it in `.dev.vars`:

- [x] 🔒 `CLOUDFLARE_API_TOKEN=...` — scopes: Account → *Workers Scripts:Edit, D1:Edit,
      Workers R2 Storage:Edit, Cloudflare Pages:Edit, Access: Apps and Policies:Edit,
      Account Settings:Read*; Zone → *DNS:Edit, Zone:Read* (only if using a custom domain).
- (If you skip this, I'll use the current login and tell you exactly what it couldn't do —
  likely the Access app, which you'd then click-create from a recipe I'll provide.)

## C. Cloudflare Access (admin UI protection) — ⛔ for Phase 6

- [x] Zero Trust is enabled on the account? (free plan is fine) — yes / no: `yes free`
- [x] Team/org domain: `panspace.cloudflareaccess.com`
- [x] Admin emails allowed into the admin UI (owner + 網管):
      1. `poterpan5466@gmail.com` (owner)
      2. `__________________` (網管)

## D. Discord — ⛔ for Phase 4 (the big one)

From the Discord Developer Portal (your existing app) + your test server:

- [x] Application ID (public): `1510355256498978917`
- [x] Public Key (public): `f322b974d23880e58e830ed8ac9b587ee48d1beb16887efb0bad6617b914e2de`
- [x] 🔒 Bot Token → `.dev.vars` as `DISCORD_BOT_TOKEN=...`
- [x] Test Guild (server) ID: `1305872150015639623`
- [x] #ai-訂閱 (billing) channel ID — where the persistent 「繳費」 button message lives: `1510368202541236335`
- [ ] Per-plan role IDs (for tagging 身分組 in 開繳 notifications):
      - ChatGPT role id: `__________________`
      - Claude Standard role id: `__________________`
      - Claude Premium role id: `__________________`
      (If these roles don't exist yet, create them — or tell me to create them via API.)
- [x] Bot is invited to the test guild with scopes `bot` + `applications.commands` and
      permissions: Send Messages, Embed Links, Read Message History, Mention Roles.
      (If not, I'll generate an invite URL from the Application ID for you to click once.)

## E. Test data — ⛔ to exercise the end-to-end flow

So I can seed a realistic subscription and test button → upload → admin verify:

- [ ] Your Discord user ID (to act as a test member): `__________________`
- [ ] display name: `____________` · email (optional): `____________`
- [ ] which plan(s) you subscribe to for testing: `ChatGPT / Claude Standard / Claude Premium`
- [ ] subscription start_date (YYYY-MM-DD): `____________`
- (Add more test members the same way if you want multi-subscription routing tested.)

## F. Confirmations (🟡 defaults already applied — change only if wrong)

- [ ] Resource names `chippot-db`, `chippot-proofs` — OK? (already created)
- [ ] billing_day = **5**, overdue_days = **3**, proof_retention_months = **24** — OK?
- [ ] Cron time 01:00 UTC = **09:00 Asia/Taipei** daily — OK?

---

### How to hand it back
1. Fill the blanks above (edit this file or paste answers in chat).
2. Put 🔒 secrets in `packages/worker/.dev.vars` (I'll `wrangler secret put` them to prod).
3. I take it from there: deploy, register the Discord command + interaction endpoint,
   configure Access, and run a live end-to-end smoke test.
