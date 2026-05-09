/**
 * Sign dashboard-bound API actions (archive, unlist, etc.) with the local
 * deployer / author keypair. Mirrors `signDashboardMessage` in
 * server-auth/dashboard-auth.ts byte-for-byte so the server's
 * `verifyDashboardSignature` accepts the result.
 *
 * Canonical message (utf-8):
 *   "chest-dashboard:{wallet}:{action}:{resourceId}:{windowTs}"
 *
 *   wallet     = base58 Solana pubkey of the signer
 *   action     = e.g. "deployment:archive", "app:unlist"
 *   resourceId = the slug (or "-" when unused)
 *   windowTs   = Math.floor(Date.now() / 300_000), 5-minute window
 *
 * Output: ed25519 signature, base64-encoded, sent in the X-Dashboard-Sig
 * header.
 */

import { ed25519 } from "@noble/curves/ed25519";

export type DashboardAction =
  | "deployment:archive"
  | "deployment:unlist"
  | "app:archive"
  | "app:unlist";

export interface DashboardSignatureInput {
  wallet: string;
  action: DashboardAction;
  resourceId: string;
}

const WINDOW_MS = 300_000;

export function signDashboardMessage(
  input: DashboardSignatureInput,
  secretKey: Uint8Array,
): string {
  const seed = secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey;
  const windowTs = Math.floor(Date.now() / WINDOW_MS);
  const msg = new TextEncoder().encode(
    `chest-dashboard:${input.wallet}:${input.action}:${input.resourceId}:${windowTs}`,
  );
  return Buffer.from(ed25519.sign(msg, seed)).toString("base64");
}
