/**
 * Referral signature verification for Chest Gate.
 *
 * Agents that send X-Referrer-Wallet must also sign a canonical message with
 * their private key and include the signature in X-Referrer-Sig. This prevents
 * wallet spoofing, only the wallet owner can prove they referred the request.
 *
 * Payout separation: agents may optionally include X-Referrer-Payout to direct
 * commission to a cold wallet different from the signing key. The payout address
 * is committed inside the signature, so it cannot be tampered in transit.
 *
 * Message format (utf-8 encoded):
 *   With payout:    "chest-referral:{signerPubkey}:{payoutWallet}:{slug}:{amountMicros}:{windowTs}"
 *   Without payout: "chest-referral:{signerPubkey}:{slug}:{amountMicros}:{windowTs}"
 *
 * windowTs = Math.floor(Date.now() / 60_000), 1-minute window
 * We accept the current window and the previous window to handle clock skew.
 *
 * Unsigned referrers:
 *   By default the proxy requires a valid signature. Merchants can opt in to
 *   allowing unsigned X-Referrer-Wallet headers by setting allowUnsignedReferrers: true
 *   in their split config. This is useful for trusted internal agents or demos but
 *   removes the anti-spoofing guarantee.
 */

import { ed25519 } from "@noble/curves/ed25519";

const WINDOW_MS = 60_000; // 1-minute windows

// ─── Message building ─────────────────────────────────────────────────────────

/**
 * Build the canonical referral message that the agent must sign.
 * amountMicros = USDC atomic units (6 decimals), e.g. 5000 = $0.005
 */
export function buildReferralMessage(
  signerPubkey: string,
  slug: string,
  amountMicros: number,
  windowTs: number,
  payoutWallet?: string
): Uint8Array {
  const msg = payoutWallet
    ? `chest-referral:${signerPubkey}:${payoutWallet}:${slug}:${amountMicros}:${windowTs}`
    : `chest-referral:${signerPubkey}:${slug}:${amountMicros}:${windowTs}`;
  return new TextEncoder().encode(msg);
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify an ed25519 signature over the referral message.
 * Returns true if the signature is valid for the given pubkey.
 */
export function verifyReferralSignature(
  signerPubkeyBase58: string,
  sigBase64: string,
  slug: string,
  amountMicros: number,
  payoutWallet?: string
): boolean {
  try {
    const pubkeyBytes = base58Decode(signerPubkeyBase58);
    const sigBytes = Buffer.from(sigBase64, "base64");

    const now = Date.now();
    const currentWindow = Math.floor(now / WINDOW_MS);

    // Accept current window or previous (handles clock skew)
    for (const windowTs of [currentWindow, currentWindow - 1]) {
      const msg = buildReferralMessage(signerPubkeyBase58, slug, amountMicros, windowTs, payoutWallet);
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

// ─── Header parsing ───────────────────────────────────────────────────────────

/**
 * Parse referral headers from a request.
 * X-Referrer-Wallet: signer pubkey (required)
 * X-Referrer-Sig:    ed25519 signature (required unless allowUnsignedReferrers)
 * X-Referrer-Payout: cold wallet for commission payout (optional, must be in sig)
 */
export function parseReferralHeaders(
  getHeader: (name: string) => string | null | undefined
): { wallet: string; sig: string | null; payout: string | null } | null {
  const wallet = getHeader("x-referrer-wallet");
  if (!wallet?.trim()) return null;

  const sig = getHeader("x-referrer-sig") || null;
  const payout = getHeader("x-referrer-payout") || null;

  return {
    wallet: wallet.trim(),
    sig: sig?.trim() ?? null,
    payout: payout?.trim() ?? null,
  };
}

// ─── Main resolver ────────────────────────────────────────────────────────────

export interface ResolveReferrerOptions {
  /** When true, accept X-Referrer-Wallet with no signature (merchant opt-in). Default: false. */
  allowUnsigned?: boolean;
}

export interface ResolvedReferrer {
  /** Wallet address that will receive the commission payout */
  payoutWallet: string;
  /** Whether this referrer was verified via signature (false = unsigned passthrough) */
  verified: boolean;
}

/**
 * Resolve and verify the referrer from request headers.
 *
 * Returns the payout wallet + verification status, or null if no valid referrer.
 *
 * With allowUnsigned=false (default):
 *   - Missing sig → null (no commission, warns logged by proxy)
 *   - Invalid sig → null
 *   - Valid sig, no payout header → payout = signer wallet
 *   - Valid sig + X-Referrer-Payout → payout = payout wallet (committed in sig)
 *
 * With allowUnsigned=true:
 *   - Missing sig → payout = X-Referrer-Wallet (unverified passthrough)
 *   - Valid sig → same as above
 *
 * @param getHeader    - Function to retrieve a header by name (case-insensitive)
 * @param slug         - API name used in PDA derivation (config.name)
 * @param amountMicros - USDC atomic amount from payment requirements
 * @param opts         - Options including allowUnsigned
 */
export function resolveReferrer(
  getHeader: (name: string) => string | null | undefined,
  slug: string,
  amountMicros: number,
  opts: ResolveReferrerOptions = {}
): ResolvedReferrer | null {
  const parsed = parseReferralHeaders(getHeader);
  if (!parsed) return null;

  // No signature present
  if (!parsed.sig) {
    if (opts.allowUnsigned) {
      return { payoutWallet: parsed.payout ?? parsed.wallet, verified: false };
    }
    return null;
  }

  // Verify signature, payout wallet must be committed inside the sig when present
  const valid = verifyReferralSignature(
    parsed.wallet,
    parsed.sig,
    slug,
    amountMicros,
    parsed.payout ?? undefined
  );

  if (!valid) return null;

  return {
    payoutWallet: parsed.payout ?? parsed.wallet,
    verified: true,
  };
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
