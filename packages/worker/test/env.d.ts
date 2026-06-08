/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

// `cloudflare:test`'s `env` is typed as `Cloudflare.Env`. Extend it from the app's
// single binding source (src/env.ts) and add the test-only TEST_MIGRATIONS binding.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      // The harness always injects R2 (vitest.config.ts `miniflare.r2Buckets`), so override
      // the app's optional `BUCKET?` to non-optional here. R2-absent behavior is exercised by
      // tests that locally set `env.BUCKET = undefined`.
      BUCKET: R2Bucket;
    }
  }
}
