import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// VITE_API_BASE is statically inlined at build time and points the upload page at the user's
// own worker. If it's missing, `vite build` still succeeds and emits a bundle that throws at
// load (white screen) — invisible to CI's `pnpm -r build`. Fail the BUILD instead so a fork
// finds out immediately. (dev is exempt: `vite dev` can run against a proxy/placeholder.)
export default defineConfig(({ command, mode }) => {
  if (command === "build" && !loadEnv(mode, process.cwd(), "VITE_").VITE_API_BASE) {
    throw new Error(
      "VITE_API_BASE is required for the web build. Point it at your worker, e.g.\n" +
        "  VITE_API_BASE=https://chippot.<your-subdomain>.workers.dev pnpm --filter @chippot/web build"
    );
  }
  return { plugins: [react()] };
});
