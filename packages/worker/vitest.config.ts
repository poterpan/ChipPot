import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      // Storage isolation is per test FILE (writes persist across `it` blocks in a
      // file, then roll back at file end). There is no per-test rollback, so DB tests
      // must be collision-free within a file. `singleWorker`/`isolatedStorage` were
      // removed in pool-workers 0.16.
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // Declare the Worker's bindings here, not via wrangler.toml, so the test
          // harness is decoupled from deployment-specific config. R2 is OPTIONAL in
          // production (wrangler.toml's [[r2_buckets]] may be removed — see env.ts
          // `BUCKET?`), so a fork that drops it must still get a working test bucket;
          // otherwise `env.BUCKET` is undefined and the storage suite breaks. miniflare
          // options take precedence over (and merge with) the wrangler config, while
          // compatibility_date/flags + vars still come from wrangler.toml.
          d1Databases: ["DB"],
          r2Buckets: ["BUCKET"],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
