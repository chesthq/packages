/**
 * Auto-resolve the calling App's slug so authors don't hand-type it
 * in every paidFetch call.
 *
 * Slug forms accepted:
 *   - bare: `market-read` (canonical, what the dashboard teaches)
 *   - prefixed: `@alice/market-read` (back-compat — server normalises
 *     to the bare form for scope lookup, so both resolve identically)
 *
 * Resolution order:
 *   1. explicit `opts.appSlug` (caller wins, always)
 *   2. `CHEST_APP_SLUG` env var (works in any runtime)
 *   3. nearest `app.md` walking up from cwd, frontmatter `author` + `name`
 *      (Node only, capped at 6 levels, memoised per process)
 *
 * Set `CHEST_APP_SLUG_DISABLE=1` to opt out of filesystem discovery.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Accepts bare `market-read` or prefixed `@alice/market-read`. Server-side
// `normaliseAppSlugForScope()` strips the prefix, so both forms resolve to
// the same app — but bare is the canonical form going forward.
const SLUG_PATTERN = /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const MAX_WALK = 6;

let cached: string | null | undefined;

export function resolveAppSlug(explicit: string | undefined): string | undefined {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;

  const env = process.env.CHEST_APP_SLUG;
  if (typeof env === "string" && env.length > 0) {
    if (!SLUG_PATTERN.test(env)) {
      // Surface bad env early — silent acceptance leads to attribution bugs
      // that only show up months later when the author checks earnings.
      throw new Error(
        `CHEST_APP_SLUG="${env}" is not a valid app slug. Expected a bare slug like "market-read" (the @author/name form is also accepted for back-compat).`,
      );
    }
    return env;
  }

  if (process.env.CHEST_APP_SLUG_DISABLE === "1") return undefined;
  if (cached !== undefined) return cached ?? undefined;

  cached = discoverFromAppMd(process.cwd());
  return cached ?? undefined;
}

/** Reset the in-process cache. Tests only — not part of the public API. */
export function _resetAppSlugCache(): void {
  cached = undefined;
}

function discoverFromAppMd(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < MAX_WALK; i++) {
    const candidate = join(dir, "app.md");
    if (existsSync(candidate)) {
      const slug = parseSlugFromAppMd(candidate);
      if (slug) return slug;
      // Found app.md but it didn't yield a slug — stop here so we don't
      // accidentally pick up an unrelated app.md higher in the tree.
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function parseSlugFromAppMd(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  // Frontmatter delimited by `---` on its own line, top of file.
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) return null;
  const front = match[1];
  const author = pickScalar(front, "author");
  const name = pickScalar(front, "name");
  // Author is still required by the manifest schema (used for on-chain
  // identity + registry display), but the slug we hand back is the bare
  // `name` — that's what the dashboard teaches and what the server
  // normalises to for scope lookup.
  if (!author || !name) return null;
  return SLUG_PATTERN.test(name) ? name : null;
}

function pickScalar(front: string, key: string): string | null {
  // Top-level scalar: `key: value` (optionally quoted, single line). We
  // deliberately skip nested keys, lists, and multi-line strings — those
  // can't appear for `author` or `name` per the manifest schema.
  const re = new RegExp(`^${key}\\s*:\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\n#]+?))\\s*(?:#.*)?$`, "m");
  const m = front.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
}
