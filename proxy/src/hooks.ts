/**
 * Lifecycle hooks for the Chest Gate proxy.
 *
 * Hooks run **in-process, in the same Node process as the proxy**, and are
 * intended for fast, safe-to-fail logic: logging, metering, custom gating,
 * telemetry. For delivery-guaranteed event handling (push to your backend,
 * sync to a database, refund logic), register a webhook instead, the
 * webhook system retries, replays, and decouples failure modes.
 *
 * | Need                                          | Surface                |
 * | --------------------------------------------- | ---------------------- |
 * | inline logging / metering / gating            | hooks (this module)    |
 * | guaranteed delivery to author backends        | webhook subscriptions  |
 *
 * Event payload shapes (`RequestEvent`, `SettledEvent`) live in
 * `@chest-gate/sdk` so consumers can import the same types without a
 * dependency on the proxy implementation.
 */

import type { RequestEvent, SettledEvent } from "@chest-gate/sdk";

export type { RequestEvent, SettledEvent };

export interface ProxyHooks {
  /**
   * Fires after payment verification, before settlement.
   *
   * Awaited inline. **Throwing aborts the call with HTTP 403**, no
   * settlement, no `onSettled`. Keep handlers fast; slow hooks block the
   * proxy's response time.
   */
  onRequest?: (ev: RequestEvent) => void | Promise<void>;

  /**
   * Fires after `facilitator.settle()` confirms the x402 transaction.
   *
   * Fire-and-forget. Errors thrown from this hook are logged at `error`
   * but never block the response or the distribute crank. Settlement is
   * final on-chain regardless of what this hook does.
   */
  onSettled?: (ev: SettledEvent) => void | Promise<void>;
}
