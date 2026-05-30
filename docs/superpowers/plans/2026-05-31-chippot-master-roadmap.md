# ChipPot — Master Roadmap & Architecture

> Companion to the spec **「訂閱代管收費系統 — 需求規格文件 v2」**. This roadmap locks in
> architecture, file structure, global conventions, phase breakdown, the credential
> checklist, and deliberate deviations from the spec. Each phase has its own detailed
> plan file and produces working, testable software on its own.

**Product name:** ChipPot · **Repo dir:** `chippot` · **Owner:** poterpan5466@gmail.com

**Goal:** A 100%-serverless subscription billing/reconciliation system on the Cloudflare
stack (Pages + Workers + D1 + R2 + Cron + Access), serving a non-profit club's AI
subscription co-purchase (OpenAI / Anthropic) over Discord, with a clean core/adapter
split so LINE/Telegram and multi-workspace are "fill-in-the-blank" later.

**Tech stack:** Cloudflare Workers (TypeScript), D1 (SQLite), R2, Cron Triggers,
Cloudflare Access; Vite + React for the two Pages frontends; Vitest with
`@cloudflare/vitest-pool-workers` (real D1/R2 in tests via Miniflare); pnpm workspace
monorepo; wrangler 4.x.

---

## 1. Architecture: core / adapter split (mandatory)

```
                ┌─────────────────────── Cloudflare Worker ───────────────────────┐
  Discord  ──►  │  adapters/discord  ─┐                                            │
  Web page ──►  │  routes/upload     ─┼─►  CORE (channel-agnostic)                 │
  Admin UI ──►  │  routes/admin      ─┤      time · tokens · audit · payments      │
  Cron     ──►  │  cron/scheduled    ─┘      billing · reconcile · storage · db    │
                │                          ▲                                       │
                │                          └── D1 (SQLite) · R2 (private bucket)    │
                └──────────────────────────────────────────────────────────────────┘
```

- **Core layer** (`src/core/*`) knows nothing about Discord. It speaks abstract events:
  "user X in workspace W wants to pay → issue link / record payment", "notify this group
  → return content". Pure-ish functions over D1/R2 bindings, fully unit-testable.
- **Adapter layer** (`src/adapters/discord/*`) translates channel input → core events and
  core output → channel format. All Discord-specific logic (Ed25519, interaction JSON,
  role/personal tags, custom_id encoding) lives here. LINE/Telegram get sibling folders
  later; the adapter interface is defined in `src/adapters/types.ts`.
- **Multi-workspace:** every row hangs off `workspace_id`. This phase seeds exactly one
  workspace ("社團 AI 訂閱"); nothing may assume `workspace_id = 1` in business logic — it
  is always resolved/passed explicitly.

## 2. Repo / file structure (pnpm monorepo)

```
chippot/
├── package.json                 # workspace root scripts
├── pnpm-workspace.yaml
├── README.md                    # built up across phases; deploy guide in Phase 8
├── .gitignore
├── docs/superpowers/plans/      # these plan files
└── packages/
    ├── worker/                  # the single Cloudflare Worker (API+Discord+upload+cron)
    │   ├── wrangler.toml
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   ├── worker-configuration.d.ts   # generated env types (wrangler types)
    │   ├── migrations/
    │   │   ├── 0001_init.sql
    │   │   └── 0002_seed.sql
    │   ├── src/
    │   │   ├── index.ts         # entry: { fetch, scheduled }
    │   │   ├── env.ts           # Env binding type + settings schema/parse
    │   │   ├── router.ts        # tiny path router (no framework)
    │   │   ├── http.ts          # json()/error()/cors helpers
    │   │   ├── core/
    │   │   │   ├── time.ts      # Asia/Taipei business date + UTC ISO  (Phase 1)
    │   │   │   ├── tokens.ts    # token gen + sha256 hash              (Phase 1)
    │   │   │   ├── audit.ts     # audit_logs writer                   (Phase 1)
    │   │   │   ├── db.ts        # typed D1 query/repo helpers          (Phase 1)
    │   │   │   ├── payments.ts  # payment CRUD + state machine         (Phase 2)
    │   │   │   ├── billing.ts   # period calc + create-first-payment   (Phase 2)
    │   │   │   ├── reconcile.ts # 對帳統計 by verified_channel_tag      (Phase 2)
    │   │   │   └── storage.ts   # R2 put/get/delete + compensation     (Phase 2)
    │   │   ├── adapters/
    │   │   │   ├── types.ts     # ChannelAdapter interface             (Phase 4)
    │   │   │   └── discord/     # ed25519, interactions, notify, ids   (Phase 4)
    │   │   ├── routes/
    │   │   │   ├── admin/       # /admin/* handlers (Access-gated)      (Phase 3)
    │   │   │   ├── upload.ts    # public token-gated upload            (Phase 3)
    │   │   │   ├── images.ts    # protected R2 image stream            (Phase 3)
    │   │   │   └── interactions.ts # Discord endpoint                  (Phase 4)
    │   │   ├── middleware/
    │   │   │   └── access.ts    # Cloudflare Access JWT verify         (Phase 3)
    │   │   └── cron/
    │   │       └── scheduled.ts # billing + overdue + retention        (Phase 7)
    │   └── test/                # vitest specs mirror src/
    ├── web/                     # Vite+React public upload page (Pages) (Phase 5)
    └── admin/                   # Vite+React admin UI (Pages, Access)   (Phase 6)
```

Two **separate Pages projects** (`web` public upload, `admin` Access-gated) for a clean
security boundary — proposed subdomains `pay.<domain>` and `admin.<domain>` (final names
chosen at deploy time).

## 3. Global conventions (hard-coded — §4 of spec)

| Concept | Type | Rule |
|---|---|---|
| timestamps (`*_at`) | `TEXT` | UTC ISO 8601 **with millis**, e.g. `2026-05-30T12:34:56.000Z` (`new Date().toISOString()`) |
| business dates (`start_date`, `period_start/end`, `due_date`, `proof_deleted_at` date part) | `TEXT` | `YYYY-MM-DD`, computed in **Asia/Taipei** |
| period | `TEXT` | `YYYY-MM` (Asia/Taipei) |
| amounts | `INTEGER` | TWD whole numbers |
| booleans | `INTEGER NOT NULL DEFAULT 0/1` + `CHECK (col IN (0,1))` |

**All** "is today billing_day", "how many days overdue" logic goes through
`core/time.ts` using `Intl.DateTimeFormat(..., { timeZone: 'Asia/Taipei' })`. Never
derive a business date straight from a UTC date inside the Cron (it runs in UTC).

## 4. Deliberate deviations / decisions (flag for owner review)

1. **`notification_logs` dedup columns are `NOT NULL DEFAULT 0`, not nullable.**
   The spec lists `plan_id/user_id/subscription_id` as nullable and relies on
   `UNIQUE(workspace_id, type, period, plan_id, user_id, subscription_id)` for dedup.
   **In SQLite, NULLs are distinct in UNIQUE constraints**, so nullable columns would
   silently *defeat* dedup (two identical "billing_opened" rows with NULL user_id would
   both insert). We store sentinel `0` for the not-applicable dimension so the UNIQUE
   actually dedupes and `INSERT … ON CONFLICT DO NOTHING` works. These columns carry no
   FK in the spec, so the sentinel is safe.
2. **Two Pages projects** (public upload vs admin) instead of one — cleaner Access
   boundary. Cost is one extra Pages deploy. Reversible.
3. **Seed lives in a migration** (`0002_seed.sql`) so `wrangler d1 migrations apply`
   bootstraps a usable system (1 workspace, 3 plans, 2 example channel_tags). Prices are
   editable later via the admin UI.
4. **`payments.source` CHECK includes `'user'`** (the spec's stated DEFAULT) plus the
   four enumerated values (`user_slash`, `user_web`, `admin_manual`, `cron`).
5. **No `Date.now()` randomness in business logic paths is hidden** — `time.ts` and
   `tokens.ts` take an injectable `Date`/use `crypto` so they are deterministically
   testable.

If any of these are not acceptable, say so and I'll adjust before/at the relevant phase.

## 5. Phase breakdown (each = one reviewable, testable deliverable)

| Phase | Scope (spec refs) | Deliverable / "done" check |
|---|---|---|
| **1 — Foundation** | scaffold, D1 schema + seed, `time`/`tokens`/`audit`/`db` (§4, §5, §17.1-2) | `pnpm test` green; `wrangler d1 migrations apply` works on local+remote; seed present |
| **2 — Core domain** | payments state machine, billing/period calc + create-first-payment, reconcile, R2 storage + compensation (§5.5, §7.7, §8, §17.3) | core logic fully unit-tested vs local D1/R2 |
| **3 — Endpoints & security** | router, Access middleware, admin CRUD APIs, token upload endpoint, protected image endpoint, CORS (§10, §11) | endpoint tests green; manual curl against `wrangler dev` |
| **4 — Discord adapter** | Ed25519 verify, interactions (button + `/繳費` slash: autocomplete, attachment, deferred, plan routing, two image paths), persistent message endpoint, command registration (§7, §11.4, §11.6) | interaction tests with mocked Discord; live ping in a test guild |
| **5 — Web upload page** | Vite+React, token entry, plan select, client canvas compression, upload (§7.5, §7.6) | deployed `web` Pages; real upload writes payment + screenshot |
| **6 — Admin frontend** | all §10 pages incl. protected image view, audit-logged mutations | deployed `admin` Pages behind Access |
| **7 — Cron & notifications** | scheduled: idempotent billing + billing_opened/overdue notify (dedup) + retention delete; Discord role/personal tags (§8.1, §9, §13) | scheduled handler tested; dry-run + live in test guild |
| **8 — Deploy & wire** | real bindings, Pages deploys, Access config, R2 private, Cron schedule, Discord app registration, README runbook (§17.11) | end-to-end live smoke test |

Plan files: `2026-05-31-chippot-phaseN-<name>.md`, written at the start of each phase
after the previous phase's review.

## 6. Credentials & resources checklist (owner provides; I request per phase)

| When | What I need from you | Why |
|---|---|---|
| Phase 1 deploy | `wrangler login` in this session (`! wrangler login`) **or** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | create/apply remote D1, deploy worker |
| Phase 1 | confirm D1 database name + R2 bucket name (defaults `chippot-db`, `chippot-proofs`) | wrangler.toml bindings |
| Phase 3/6 | Access team domain + the 2 admin emails; confirm admin subdomain | Access JWT audience + allowed identities |
| Phase 4 | Discord **Application ID**, **Public Key**, **Bot Token**, a **test guild id**, the **#ai-訂閱 channel id**, plan **role ids** | sign verify, register commands, send messages, tag roles |
| Phase 5/6 | the custom domain + desired subdomains (`pay.`, `admin.`) | Pages custom domains + CORS allowlist |

Secrets go via `wrangler secret put` / Pages env vars / `.dev.vars` (gitignored) — never
committed. I will pause and ask at each gate rather than guess.

## 7. Working agreement

- Phased delivery; I stop for your review at each phase boundary before starting the next.
- TDD throughout (Vitest). Frequent small commits. Conventional-commit messages.
- Every admin mutation writes an `audit_logs` row (enforced from Phase 3 onward).
- I surface any spec ambiguity as a decision in §4 of this doc or as a direct question.
