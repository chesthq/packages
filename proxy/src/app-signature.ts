/**
 * App publish signature verification.
 *
 * The POST /api/apps endpoint is permissionless, any Solana wallet can
 * publish. The signature binds the author wallet to the **entire manifest**
 * (every caller-provided field, not just installJson) plus the slug + version.
 * Mutating any field without bumping the version invalidates the signature,
 * so "immutable post-publish" is enforced by the wire format rather than by
 * server-side policy.
 *
 * Canonical message (utf-8):
 *   "chest-app/v4:{author}:{slug}:{manifestHash}:{version}:{windowTs}"
 *
 *   author       = base58 Solana pubkey of the signer (the author wallet)
 *   slug         = app slug, lowercased
 *   manifestHash = lowercase hex sha256 of canonical JSON.stringify of the
 *                  manifest object (see `buildManifestObject`)
 *   version      = semver-ish string (not parsed; opaque identifier)
 *   windowTs     = Math.floor(Date.now() / 300_000), 5-minute window
 *
 * Signed bytes are ed25519 over utf-8, base64-encoded in X-App-Sig.
 *
 * Versioning: the `/vN` infix in the canonical prefix gives us a graceful
 * upgrade path. Bumping the format (adding/removing a committed field)
 * means rolling the prefix so signatures over the old shape can never be
 * accidentally accepted under the new rules. v4 dropped `authorHandle` —
 * the displayed author name now resolves live from RefererProfile by
 * wallet at read time.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

const WINDOW_MS = 300_000;
const PREFIX = "chest-app/v4";

export interface AppSignatureInput {
  author: string;
  slug: string;
  manifestHash: string;
  version: string;
}

export interface AppVerifyResult {
  valid: boolean;
  /** When valid, the windowTs that matched. Used by the publish endpoint to
   *  enforce a monotonic per-slug nonce (replay protection). */
  windowTs?: number;
}

/** Caller-provided manifest fields that must be byte-stable for the hash. */
export interface AppManifestFields {
  name: string;
  kind: string;
  tagline: string;
  description?: string | null;
  readme?: string | null;
  endpointsCsv: string;
  referrerBps?: number | null;
  sourceUrl?: string | null;
  homepageUrl?: string | null;
  installJson?: unknown;
}

/**
 * Build the canonical manifest object for hashing. Optional / undefined /
 * absent fields normalize to null so client and server agree byte-for-byte
 * regardless of how the request was constructed (form omission vs explicit
 * null vs undefined property).
 */
export function buildManifestObject(
  fields: AppManifestFields,
): Record<string, unknown> {
  return {
    name: fields.name,
    kind: fields.kind,
    tagline: fields.tagline,
    description:
      fields.description === undefined || fields.description === null
        ? null
        : fields.description,
    readme:
      fields.readme === undefined || fields.readme === null ? null : fields.readme,
    endpointsCsv: fields.endpointsCsv,
    referrerBps:
      fields.referrerBps === undefined || fields.referrerBps === null
        ? null
        : fields.referrerBps,
    sourceUrl:
      fields.sourceUrl === undefined || fields.sourceUrl === null ? null : fields.sourceUrl,
    homepageUrl:
      fields.homepageUrl === undefined || fields.homepageUrl === null
        ? null
        : fields.homepageUrl,
    installJson:
      fields.installJson === undefined ? null : fields.installJson,
  };
}

export function buildAppMessage(
  input: AppSignatureInput,
  windowTs: number,
): Uint8Array {
  const { author, slug, manifestHash, version } = input;
  const msg = `${PREFIX}:${author}:${slug.toLowerCase()}:${manifestHash}:${version}:${windowTs}`;
  return new TextEncoder().encode(msg);
}

/**
 * Verify an ed25519 signature over the canonical app message. Returns
 * `valid: true` plus the matched windowTs so callers can enforce monotonic
 * replay protection.
 */
export function verifyAppSignature(
  input: AppSignatureInput,
  sigBase64: string,
): AppVerifyResult {
  try {
    const pubkeyBytes = base58Decode(input.author);
    if (pubkeyBytes.length !== 32) return { valid: false };
    const sigBytes = Buffer.from(sigBase64, "base64");

    const currentWindow = Math.floor(Date.now() / WINDOW_MS);
    for (const windowTs of [currentWindow, currentWindow - 1]) {
      const msg = buildAppMessage(input, windowTs);
      try {
        if (ed25519.verify(sigBytes, msg, pubkeyBytes)) {
          return { valid: true, windowTs };
        }
      } catch {
        // malformed input, try next window
      }
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

export function signAppMessage(
  input: AppSignatureInput,
  seedBytes: Uint8Array,
): string {
  const seed = seedBytes.length === 64 ? seedBytes.slice(0, 32) : seedBytes;
  const windowTs = Math.floor(Date.now() / WINDOW_MS);
  const msg = buildAppMessage(input, windowTs);
  const sig = ed25519.sign(msg, seed);
  return Buffer.from(sig).toString("base64");
}

/**
 * Canonical JSON stringify with recursively sorted object keys. Arrays keep
 * their order. Matches the hash the publish endpoint computes server-side.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashManifest(fields: AppManifestFields): string {
  const canonical = canonicalJson(buildManifestObject(fields));
  const bytes = new TextEncoder().encode(canonical);
  const digest = sha256(bytes);
  let out = "";
  for (let i = 0; i < digest.length; i++) out += digest[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Validate `wallet` is a 32-byte base58-encoded Solana pubkey. Cheap defense
 * in depth, the signature path also fails for malformed keys, but explicit
 * validation gives clearer 400 errors.
 */
export function isValidSolanaPubkey(wallet: string): boolean {
  try {
    return base58Decode(wallet).length === 32;
  } catch {
    return false;
  }
}

// ─── Minimal base58 decoder ───────────────────────────────────────────────────
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET.charCodeAt(i)] = i;
}

function base58Decode(str: string): Uint8Array {
  if (typeof str !== "string" || str.length === 0) {
    throw new Error("Empty base58 input");
  }
  const bytes: number[] = [0];
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_MAP[str.charCodeAt(i)];
    if (val === 255) throw new Error(`Invalid base58 character: ${str[i]}`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}
