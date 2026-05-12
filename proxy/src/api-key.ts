/**
 * Referrer keys for Chest Gate.
 *
 * Attribution-only credential — identifies "who gets the cut", not "who
 * pays". The payer is authorized by the x402 signature on `X-Payment`;
 * the referrer key is metadata.
 *
 *   X-Chest-Referrer-Key: cg_pub_live_<28 chars>
 *
 * Sent on a dedicated header (not `Authorization`) so it doesn't compete
 * with the agent token's Bearer slot. That lets a caller pay via an
 * agent token AND credit a referrer in the same request when needed.
 *
 * The `pub` segment (Stripe-style "publishable") signals that this key is
 * safe to ship in distributed code — MCP servers, skill source, example
 * repos. Leaking it only credits the bound wallet for more commissions.
 *
 * The server hashes the token with HMAC-SHA256 (key = API_KEY_HASH_PEPPER)
 * and looks up the row. The row carries the `payoutWallet`, committed at
 * creation time, so a compromised dashboard session cannot redirect a
 * historical key's payouts.
 *
 * Key format: `cg_pub_{env}_{28 base58 chars}`
 *   - env = "live" (mainnet) or "test" (devnet)
 *   - random bytes drawn from crypto.randomBytes, encoded to base58
 *
 * We store the prefix (`cg_pub_live_7a2f`) so the dashboard can show a
 * recognizable fragment without ever re-displaying the full key.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BODY_BYTES = 20; // ~28 base58 chars after encoding
const PREFIX_BODY_CHARS = 4; // cg_pub_live_XXXX shown in UI

export type ApiKeyEnv = "live" | "test";

export interface GeneratedApiKey {
  /** Full key, shown to the user ONCE. Never persisted. */
  plaintext: string;
  /** cg_pub_live_XXXX, safe to store and display. */
  prefix: string;
  /** HMAC-SHA256(pepper, plaintext), hex. Stored. */
  hash: string;
}

/**
 * Generate a new API key. Requires the pepper so that the hash is
 * immediately usable for persistence, forcing callers to supply it
 * prevents "generate, forget to hash" foot-guns.
 */
export function generateApiKey(env: ApiKeyEnv, pepper: string): GeneratedApiKey {
  if (!pepper || pepper.length < 32) {
    throw new Error("API_KEY_HASH_PEPPER must be set and ≥32 chars (openssl rand -hex 32)");
  }

  const body = base58Encode(randomBytes(KEY_BODY_BYTES));
  const plaintext = `cg_pub_${env}_${body}`;
  const prefix = `cg_pub_${env}_${body.slice(0, PREFIX_BODY_CHARS)}`;
  const hash = hashApiKey(plaintext, pepper);

  return { plaintext, prefix, hash };
}

/**
 * Hash an API key for storage or lookup. The pepper is applied via HMAC so
 * that a DB leak alone does not enable offline brute-force.
 */
export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}

/** Header that carries the referrer key on gate calls. */
export const REFERRER_KEY_HEADER = "x-chest-referrer-key";

/**
 * Parse `X-Chest-Referrer-Key: cg_pub_...` and return the token only if
 * it matches the expected shape. Returns null for anything else.
 *
 * Note: this is *not* on the `Authorization` header. Bearer is reserved
 * for the spending credential (the agent token); the referrer key is
 * attribution metadata and gets its own slot so both can coexist on the
 * same request.
 */
export function extractReferrerKeyFromHeader(
  getHeader: (name: string) => string | null | undefined
): string | null {
  const raw = getHeader(REFERRER_KEY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^cg_pub_(?:live|test)_[1-9A-HJ-NP-Za-km-z]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Constant-time compare of two hex digests. Both hashes should be the same
 * length, if not, returns false without branching on content.
 */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── base58 encoder (matches Solana alphabet; decoder lives in referrer.ts) ──

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}
