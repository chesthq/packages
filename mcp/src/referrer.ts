/**
 * Referral signing for the Chest MCP server.
 *
 * Before every x402 API call, the MCP server signs a canonical message with
 * the agent's private key. The proxy verifies this signature to prevent wallet
 * spoofing — only the actual key holder earns commissions.
 *
 * Message format: "chest-referral:{pubkey}:{slug}:{amountMicros}:{windowTs}"
 */

import { ed25519 } from "@noble/curves/ed25519";

const WINDOW_MS = 60_000;

/**
 * Build the canonical referral message (mirrors proxy/src/referrer.ts).
 */
function buildReferralMessage(
  pubkey: string,
  slug: string,
  amountMicros: number,
  windowTs: number
): Uint8Array {
  const msg = `chest-referral:${pubkey}:${slug}:${amountMicros}:${windowTs}`;
  return new TextEncoder().encode(msg);
}

/**
 * Sign a referral claim and return the headers to inject into the API request.
 *
 * @param privateKeyBytes - 64-byte ed25519 secret key (or 32-byte seed — auto-detected)
 * @param pubkeyStr       - Base58-encoded Solana public key (your wallet address)
 * @param slug            - API slug matching the split config (e.g. "Sentiment API")
 * @param amountMicros    - USDC atomic units being paid
 * @returns Headers: { "X-Referrer-Wallet": string, "X-Referrer-Sig": string }
 */
export async function signReferral(
  privateKeyBytes: Uint8Array,
  pubkeyStr: string,
  slug: string,
  amountMicros: number
): Promise<{ "X-Referrer-Wallet": string; "X-Referrer-Sig": string }> {
  const windowTs = Math.floor(Date.now() / WINDOW_MS);
  const msg = buildReferralMessage(pubkeyStr, slug, amountMicros, windowTs);

  // @noble/curves ed25519.sign takes a 32-byte seed (first half of 64-byte keypair)
  const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
  const sig = ed25519.sign(msg, seed);

  return {
    "X-Referrer-Wallet": pubkeyStr,
    "X-Referrer-Sig": Buffer.from(sig).toString("base64"),
  };
}
