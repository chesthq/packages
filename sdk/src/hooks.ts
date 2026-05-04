/**
 * Lifecycle event payloads emitted by the Chest Gate proxy.
 *
 * These types are the contract between proxy implementations (which produce
 * the events) and consumer code (which observes them via `ProxyHooks`,
 * defined in `@chest/proxy`). They are exported from this SDK so any caller
 *, a deployed proxy, a webhook handler, an indexer, can import the same
 * shape:
 *
 * ```ts
 * import type { RequestEvent, SettledEvent } from "@chest-gate/sdk";
 * ```
 *
 * Hooks run in-process; for delivery-guaranteed event handling, use the
 * webhook subscription system instead.
 */

/** Fired after route+price match and payment verification, before settlement. */
export interface RequestEvent {
  /** Gate slug, matches `ProxyConfig.name`. */
  gateSlug: string;
  /** HTTP method. */
  method: string;
  /** Request path (e.g. `/price/BTC`). */
  path: string;
  /**
   * Matched route pattern (e.g. `GET /price/:symbol`) or `null` when the
   * call falls back to `defaultPrice` with no explicit route.
   */
  matchedRoute: string | null;
  /** Price in USD. 0 routes never reach hooks (free passthrough returns earlier). */
  priceUsd: number;
  /**
   * Resolved referrer wallet (verified signature, or unsigned-allowed by
   * merchant config) or `null` when no valid referrer was attached.
   */
  referrerWallet: string | null;
  /** Payer wallet, from x402 verification. */
  payerWallet: string;
}

/** Fired after the x402 settlement transaction confirms on-chain. */
export interface SettledEvent extends RequestEvent {
  /** Solana tx signature of the x402 settlement. */
  txSignature: string;
  /** ISO 8601 timestamp of settlement (server clock). */
  settledAt: string;
  /**
   * Predicted split amounts in USD. The settlement transaction lands the
   * total in the configured vault; the split distribute crank runs async
   * and may fail or retry. Use a webhook for delivery-guaranteed notice
   * of distributed splits.
   */
  amounts: {
    totalUsd: number;
    providerUsd: number;
    /** 0 when no referrer is attached. */
    referrerUsd: number;
    /** 0 when no on-chain split is configured. */
    protocolUsd: number;
  };
}
