import type { Env } from "./env";

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("ChipPo worker", { status: 200 });
  },
  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    // Cron handler implemented in Phase 7.
  },
} satisfies ExportedHandler<Env>;
