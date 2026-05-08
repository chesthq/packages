/**
 * Referral signing for the Chest MCP server.
 *
 * Signs a canonical message with the agent's hot key to prove wallet ownership.
 * Optionally commits a separate cold wallet for payout, so if the hot key is
 * compromised, commission funds go to the cold wallet instead.
 *
 * Message format:
 *   With payout:    "chest-referral:{signerPubkey}:{payoutWallet}:{slug}:{amountMicros}:{windowTs}"
 *   Without payout: "chest-referral:{signerPubkey}:{slug}:{amountMicros}:{windowTs}"
 */

import { ed25519 } from "@noble/curves/ed25519";

const WINDOW_MS = 60_000;

function buildReferralMessage(
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

/**
 * Sign a referral claim and return the headers to inject into the API request.
 *
 * @param privateKeyBytes - 64-byte ed25519 secret key (or 32-byte seed, auto-detected)
 * @param signerPubkey    - Base58 public key of the signing key (hot wallet)
 * @param slug            - API name matching the split config
 * @param amountMicros    - USDC atomic units being paid
 * @param payoutWallet    - Optional cold wallet to receive the commission instead of signerPubkey
 */
export async function signReferral(
  privateKeyBytes: Uint8Array,
  signerPubkey: string,
  slug: string,
  amountMicros: number,
  payoutWallet?: string
): Promise<{ "X-Referrer-Wallet": string; "X-Referrer-Sig": string; "X-Referrer-Payout"?: string }> {
  const windowTs = Math.floor(Date.now() / WINDOW_MS);
  const msg = buildReferralMessage(signerPubkey, slug, amountMicros, windowTs, payoutWallet);

  // @noble/curves ed25519.sign takes a 32-byte seed (first half of 64-byte keypair)
  const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
  const sig = ed25519.sign(msg, seed);

  const headers: { "X-Referrer-Wallet": string; "X-Referrer-Sig": string; "X-Referrer-Payout"?: string } = {
    "X-Referrer-Wallet": signerPubkey,
    "X-Referrer-Sig": Buffer.from(sig).toString("base64"),
  };

  if (payoutWallet) {
    headers["X-Referrer-Payout"] = payoutWallet;
  }

  return headers;
}
