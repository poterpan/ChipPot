/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

// `cloudflare:test`'s `env` is typed as `Cloudflare.Env`. Extend it from the app's
// single binding source (src/env.ts) and add the test-only TEST_MIGRATIONS binding.
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      BUCKET: R2Bucket; // tests always provide R2; override the app's optional binding
    }
  }
}
