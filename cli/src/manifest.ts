/**
 * app.md manifest, the authoring-side artifact for an App (an install-ready
 * agent capability that wraps one or more paid Gates).
 *
 * Authors keep an `app.md` in their repo with YAML frontmatter declaring the
 * App's identity, the upstream Gates it calls, and human-readable metadata.
 * The markdown body becomes the listing description on chest.sh.
 *
 * The payout wallet is **deliberately not a manifest field**, it is resolved
 * from the on-chain author record (npm/crates.io/Hugging Face pattern).
 * Wallet rotation, multi-sig payouts, and impersonation prevention all live
 * on the author record, not in every manifest.
 *
 * Hand-rolled validator (no zod dep). Returns either a typed manifest or
 * a structured list of errors with field paths so the CLI can render them
 * with line/column hints.
 */

import { readFile } from "node:fs/promises";
import matter from "gray-matter";

export const CAPABILITY_TAGS = [
  "INFERENCE",
  "SEARCH",
  "DATA",
  "MEDIA",
  "INFRA",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export const APP_KINDS = ["skill", "plugin", "mcp"] as const;
export type AppKind = (typeof APP_KINDS)[number];

export interface AppManifest {
  /** kebab-case slug, [a-z0-9-]+, max 64 chars. Identifier within the author's namespace. */
  name: string;
  /** Author handle, prefixed with @, e.g. "@smd00". Resolves to on-chain author record. */
  author: string;
  /** Valid semver, e.g. "0.1.0". */
  version: string;
  /** 1–280 chars. Used as the registry listing tagline. */
  description: string;
  /** ≥1 capability tags from the enum. */
  capabilityTags: CapabilityTag[];
  /** Optional gate slugs this app pays (bare form, e.g. `market-read`). Legacy `@author/name` accepted for back-compat. */
  upstreamGates?: string[];
  /** Optional https URL. */
  homepage?: string;
  /** Optional https URL. */
  repository?: string;
  /** Optional SPDX identifier. Free-form string for v1. */
  license?: string;
  /** Markdown body (everything below the frontmatter `---` delimiter). */
  body: string;
  /** App kind for the registry. Defaults to "skill" at publish time. */
  kind?: AppKind;
  /** Single-component gate slugs the app pays (registry-side endpoints). */
  endpoints?: string[];
  /** Optional human-readable name for the registry listing. Defaults to `name`. */
  displayName?: string;
  /** Optional short tagline ≤120 chars. Defaults to `description`. */
  tagline?: string;
  /** Optional install/config blob shipped to consumers. */
  installJson?: unknown;
}

/**
 * Canonical bare slug used by the SDK's `appSlug` option and the
 * `x-chest-app` header. Slugs are globally unique on chest.sh; the
 * `author` field stays on the manifest for on-chain identity and
 * registry display, but isn't part of the slug. The legacy
 * `@author/name` form still resolves server-side via normalisation.
 */
export function toAppSlug(m: Pick<AppManifest, "name">): string {
  return m.name;
}

export interface ManifestValidationError {
  /** Dotted field path, e.g. "name", "capabilityTags[2]". */
  path: string;
  message: string;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;
const AUTHOR_PATTERN = /^@[a-z0-9-]+$/;
// Accepts bare `market-read` or prefixed `@alice/market-read`. Server-side
// `normaliseAppSlugForScope()` strips the prefix, so both forms resolve to
// the same scope. Bare is the canonical form.
const SLUG_PATTERN = /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const HTTPS_PATTERN = /^https:\/\/[^\s]+$/;

/**
 * Parse and validate an app.md manifest from disk. Returns either the
 * typed manifest (`{ ok: true, manifest }`) or a list of errors.
 */
export async function loadManifest(
  path: string,
): Promise<
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: ManifestValidationError[] }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "<file>", message: `Cannot read ${path}: ${(err as Error).message}` }],
    };
  }

  return parseManifest(raw);
}

/**
 * Parse and validate a manifest from a raw string. Exposed separately so
 * tests don't need a real file on disk.
 */
export function parseManifest(
  raw: string,
):
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: ManifestValidationError[] } {
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const result = matter(raw);
    parsed = { data: result.data ?? {}, content: result.content ?? "" };
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "<frontmatter>", message: `Invalid YAML: ${(err as Error).message}` }],
    };
  }

  const errors: ManifestValidationError[] = [];
  const data = parsed.data;

  // name
  const name = data.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push({ path: "name", message: "required, must be a non-empty string" });
  } else if (name.length > 64) {
    errors.push({ path: "name", message: "must be ≤ 64 chars" });
  } else if (!NAME_PATTERN.test(name)) {
    errors.push({ path: "name", message: "must match [a-z0-9-]+ (kebab-case)" });
  }

  // author
  const author = data.author;
  if (typeof author !== "string" || author.length === 0) {
    errors.push({ path: "author", message: "required, must be a non-empty string" });
  } else if (!AUTHOR_PATTERN.test(author)) {
    errors.push({ path: "author", message: "must start with @ and match @[a-z0-9-]+" });
  }

  // version
  const version = data.version;
  if (typeof version !== "string" || version.length === 0) {
    errors.push({ path: "version", message: "required, must be a non-empty string" });
  } else if (!SEMVER_PATTERN.test(version)) {
    errors.push({ path: "version", message: `'${version}' is not valid semver` });
  }

  // description
  const description = data.description;
  if (typeof description !== "string" || description.length === 0) {
    errors.push({ path: "description", message: "required, must be a non-empty string" });
  } else if (description.length > 280) {
    errors.push({ path: "description", message: `${description.length} chars > 280 max` });
  }

  // capabilityTags
  const tags = data.capabilityTags;
  if (!Array.isArray(tags) || tags.length === 0) {
    errors.push({ path: "capabilityTags", message: "required, must be a non-empty array" });
  } else {
    tags.forEach((t, i) => {
      if (typeof t !== "string" || !(CAPABILITY_TAGS as readonly string[]).includes(t)) {
        errors.push({
          path: `capabilityTags[${i}]`,
          message: `'${String(t)}' is not one of ${CAPABILITY_TAGS.join(", ")}`,
        });
      }
    });
  }

  // upstreamGates (optional)
  const gates = data.upstreamGates;
  if (gates !== undefined && gates !== null) {
    if (!Array.isArray(gates)) {
      errors.push({ path: "upstreamGates", message: "must be an array of gate slugs (bare, e.g. `market-read`)" });
    } else {
      gates.forEach((g, i) => {
        if (typeof g !== "string" || !SLUG_PATTERN.test(g)) {
          errors.push({
            path: `upstreamGates[${i}]`,
            message: `'${String(g)}' must be a bare slug like 'market-read' (or legacy '@author/app-name')`,
          });
        }
      });
    }
  }

  // homepage (optional)
  if (data.homepage !== undefined && data.homepage !== null) {
    if (typeof data.homepage !== "string" || !HTTPS_PATTERN.test(data.homepage)) {
      errors.push({ path: "homepage", message: "must be an https:// URL" });
    }
  }

  // repository (optional)
  if (data.repository !== undefined && data.repository !== null) {
    if (typeof data.repository !== "string" || !HTTPS_PATTERN.test(data.repository)) {
      errors.push({ path: "repository", message: "must be an https:// URL" });
    }
  }

  // license (optional, free-form string for v1, full SPDX list is too large
  // to enforce here; the registry will warn on unknown identifiers later)
  if (data.license !== undefined && data.license !== null) {
    if (typeof data.license !== "string" || data.license.length === 0) {
      errors.push({ path: "license", message: "must be a non-empty string (SPDX identifier)" });
    }
  }

  // kind (optional)
  if (data.kind !== undefined && data.kind !== null) {
    if (typeof data.kind !== "string" || !(APP_KINDS as readonly string[]).includes(data.kind)) {
      errors.push({
        path: "kind",
        message: `'${String(data.kind)}' must be one of ${APP_KINDS.join(", ")}`,
      });
    }
  }

  // endpoints (optional)
  if (data.endpoints !== undefined && data.endpoints !== null) {
    if (!Array.isArray(data.endpoints)) {
      errors.push({ path: "endpoints", message: "must be an array of gate slugs" });
    } else {
      data.endpoints.forEach((e, i) => {
        if (typeof e !== "string" || !ENDPOINT_PATTERN.test(e)) {
          errors.push({
            path: `endpoints[${i}]`,
            message: `'${String(e)}' must match ^[a-z0-9][a-z0-9-]{1,63}$ (single-component gate slug)`,
          });
        }
      });
    }
  }

  // displayName (optional)
  if (data.displayName !== undefined && data.displayName !== null) {
    if (typeof data.displayName !== "string" || data.displayName.trim().length === 0) {
      errors.push({ path: "displayName", message: "must be a non-empty string" });
    } else if (data.displayName.length > 120) {
      errors.push({ path: "displayName", message: `${data.displayName.length} chars > 120 max` });
    }
  }

  // tagline (optional, ≤120 chars — shorter than description)
  if (data.tagline !== undefined && data.tagline !== null) {
    if (typeof data.tagline !== "string" || data.tagline.trim().length === 0) {
      errors.push({ path: "tagline", message: "must be a non-empty string" });
    } else if (data.tagline.length > 120) {
      errors.push({ path: "tagline", message: `${data.tagline.length} chars > 120 max` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      name: name as string,
      author: author as string,
      version: version as string,
      description: description as string,
      capabilityTags: tags as CapabilityTag[],
      upstreamGates: gates ? (gates as string[]) : undefined,
      homepage: data.homepage ? (data.homepage as string) : undefined,
      repository: data.repository ? (data.repository as string) : undefined,
      license: data.license ? (data.license as string) : undefined,
      body: parsed.content,
      kind: data.kind ? (data.kind as AppKind) : undefined,
      endpoints: data.endpoints ? (data.endpoints as string[]) : undefined,
      displayName: data.displayName ? (data.displayName as string) : undefined,
      tagline: data.tagline ? (data.tagline as string) : undefined,
      installJson: data.installJson ?? undefined,
    },
  };
}
