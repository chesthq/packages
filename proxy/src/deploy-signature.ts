/**
 * Deploy signature verification for Chest Gate.
 *
 * The /api/gates endpoint is permissionless, anyone with a Solana wallet can
 * register a proxy. To prevent slug squatting and upstream impersonation, the
 * deploy request must be signed by the **deployer** wallet. Ownership of the
 * slug is tied to the deployer, not the payout wallet, so deployers can
 * rotate payout wallets (e.g. cold → warm) without losing their slug.
 *
 * Deployer vs payout wallet:
 *   - `deployer`     = the wallet that signs deploy requests and owns the slug
 *   - `payoutWallet` = the address that receives USDC payments from agents
 * These are commonly the same, but separating them lets teams sign with an
 * operational hot key while directing revenue to a cold treasury. The payout
 * wallet is committed inside the signature so it cannot be tampered in transit.
 *
 * Canonical message (utf-8):
 *   v1 (no route overrides):
 *     "chest-deploy:{deployer}:{payoutWallet}:{slug}:{upstream}:{priceMicros}:{network}:{windowTs}"
 *
 *   v2 (with at least one per-route override):
 *     "chest-deploy:{deployer}:{payoutWallet}:{slug}:{upstream}:{priceMicros}:{network}:{windowTs}:routes:{routePricesHash}"
 *
 *   deployer         = base58 Solana pubkey of the signer (slug owner)
 *   payoutWallet     = base58 Solana pubkey that will receive payments
 *   slug             = slug requested in the deploy payload (lowercased)
 *   upstream         = upstream URL being wrapped (exact string match)
 *   priceMicros      = default price in USDC atomic units (6 decimals)
 *   network          = "solana-devnet" | "solana-mainnet" (normalized)
 *   windowTs         = Math.floor(Date.now() / 300_000), 5-minute window
 *   routePricesHash  = hashRoutePrices(routePrices), sha256 hex of canonical
 *                      JSON, sorted by path. See hashRoutePrices below.
 *
 * Both signer and verifier produce v1 when `routePrices` is empty/undefined,
 * and v2 when there is at least one entry. This keeps existing v1 deployers
 * working unchanged while binding per-endpoint pricing into the signature
 * for new deploys.
 *
 * We accept the current window and the previous window to handle clock skew
 * and latency between signing and request arrival.
 *
 * The signature is ed25519 over the utf-8 bytes of the canonical message,
 * base64-encoded in the X-Deploy-Sig header.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";

const WINDOW_MS = 300_000; // 5-minute windows

export interface RoutePriceEntry {
  /** Pattern as used by matchRoute, e.g. "POST /generate", "GET /price/*", "*". */
  path: string;
  /** USDC atomic units (6 decimals). 0 = free. */
  priceMicros: number;
}

export interface DeploySignatureInput {
  /** Signer wallet (owns the slug). Must be a base58 Solana pubkey. */
  deployer: string;
  /** Address that will receive USDC payments. Defaults to deployer if omitted by caller. */
  payoutWallet: string;
  slug: string;
  upstream: string;
  priceMicros: number;
  network: string;
  /**
   * Optional per-route pricing overrides. When non-empty, switches the
   * canonical message to v2 (with `:routes:{hash}` appended). Must match
   * byte-for-byte between signer and verifier, use {@link hashRoutePrices}.
   */
  routePrices?: RoutePriceEntry[];
}

/**
 * Canonical hash of a route-prices array. Sorts by path, normalises shape
 * to `{path, priceMicros}` only, JSON-stringifies, then sha256 → lowercase
 * hex. Order in the input doesn't matter; equivalent arrays hash equally.
 */
export function hashRoutePrices(routes: RoutePriceEntry[] | undefined): string {
  if (!routes || routes.length === 0) return "";
  const normalised = [...routes]
    .map((r) => ({ path: r.path, priceMicros: r.priceMicros }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = JSON.stringify(normalised);
  const digest = sha256(new TextEncoder().encode(canonical));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the canonical deploy message that the deployer must sign.
 * Both the signer and verifier must produce identical bytes, keep field
 * order and separators stable.
 */
export function buildDeployMessage(
  input: DeploySignatureInput,
  windowTs: number
): Uint8Array {
  const { deployer, payoutWallet, slug, upstream, priceMicros, network } = input;
  let msg = `chest-deploy:${deployer}:${payoutWallet}:${slug.toLowerCase()}:${upstream}:${priceMicros}:${network}:${windowTs}`;
  if (input.routePrices && input.routePrices.length > 0) {
    msg += `:routes:${hashRoutePrices(input.routePrices)}`;
  }
  return new TextEncoder().encode(msg);
}

/**
 * Verify an ed25519 signature over the canonical deploy message.
 * Returns true if the signature is valid for the deployer pubkey within the
 * current or previous 5-minute window.
 */
export function verifyDeploySignature(
  input: DeploySignatureInput,
  sigBase64: string
): boolean {
  try {
    const pubkeyBytes = base58Decode(input.deployer);
    const sigBytes = Buffer.from(sigBase64, "base64");

    const now = Date.now();
    const currentWindow = Math.floor(now / WINDOW_MS);

    for (const windowTs of [currentWindow, currentWindow - 1]) {
      const msg = buildDeployMessage(input, windowTs);
      try {
        if (ed25519.verify(sigBytes, msg, pubkeyBytes)) {
          return true;
        }
      } catch {
        // ed25519.verify throws on malformed input, try next window
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Sign a canonical deploy message with an ed25519 seed (32 bytes).
 * Returns a base64 signature suitable for the X-Deploy-Sig header.
 *
 * @param input      - Deploy payload fields (wallet, slug, upstream, priceMicros, network)
 * @param seedBytes  - 32-byte ed25519 seed, OR 64-byte expanded secret key (first 32 used)
 */
export function signDeployMessage(
  input: DeploySignatureInput,
  seedBytes: Uint8Array
): string {
  // @noble/curves ed25519.sign takes a 32-byte seed. Solana keypairs are 64 bytes
  // (seed + public key), take the first half.
  const seed = seedBytes.length === 64 ? seedBytes.slice(0, 32) : seedBytes;
  const windowTs = Math.floor(Date.now() / WINDOW_MS);
  const msg = buildDeployMessage(input, windowTs);
  const sig = ed25519.sign(msg, seed);
  return Buffer.from(sig).toString("base64");
}

// ─── Minimal base58 decoder (no extra deps) ──────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET.charCodeAt(i)] = i;
}

function base58Decode(str: string): Uint8Array {
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
  for (let i = 0; i < str.length && str[i] === "1"; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
