/**
 * Local dev entry — `npm run dev` to spin this up on http://localhost:8787.
 * Vercel uses ../index.js (the bundled handler) directly; this file isn't
 * deployed.
 */

import { serve } from "@hono/node-server";
import app from "./handler.ts";

const PORT = parseInt(process.env.PORT ?? "8787", 10);

console.log(`{{NAME}} (local) at http://localhost:${PORT}`);
console.log(`  → forwarding to {{TARGET_ORIGIN}}{{TARGET_PATH}}`);
console.log(`  → health: http://localhost:${PORT}/__health`);

serve({ fetch: app.fetch, port: PORT });
