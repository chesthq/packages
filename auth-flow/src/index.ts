/**
 * @chest-gate/auth-flow — OAuth 2.0 Device Authorization Grant (RFC 8628)
 * login flow for Chest Gate clients.
 *
 * The CLI requests a short user code from gate.chest.sh, prints it for the
 * user, optionally opens the verification URL in a browser, and polls until
 * the user signs in at chest.sh/device. Returns the freshly-minted agent
 * token. Works under SSH, Docker, CI, and headless boxes — no loopback.
 *
 * The token returned is an ordinary `ca_live_…` agent token bound to the
 * Privy-authenticated user's wallet — same kind paste-flow users mint at
 * chest.sh/dashboard/agent-wallet. Per-device, revocable, no scope
 * differences.
 */

import open from "open";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceGrantArgs {
  /** gate.chest.sh API base URL. */
  gateUrl: string;
  /** Hostname recorded in the token label. */
  hostname: string;
  /** Open the browser automatically. Default: true. */
  openBrowser?: boolean;
  /** Called once when the device code has been issued — caller prints UI. */
  onCodeIssued?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSec: number;
  }) => void;
  /** Optional override for the overall login timeout. Defaults to 15 min
   *  (matches the server-issued `expires_in`). */
  timeoutMs?: number;
}

export interface DeviceGrantResult {
  token: string;
  ownerWallet: string;
  tokenId: string;
  label: string;
}

export type DeviceGrantErrorKind =
  | "network"
  | "request"
  | "denied"
  | "expired"
  | "timeout"
  | "unknown";

export class DeviceGrantError extends Error {
  constructor(
    public readonly kind: DeviceGrantErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DeviceGrantError";
  }
}

/**
 * Run the full RFC 8628 device-grant flow and return the minted token.
 *
 * @throws DeviceGrantError on any failure (network, denied, expired,
 *   timeout, unknown server error).
 */
export async function runDeviceGrant(
  args: DeviceGrantArgs,
): Promise<DeviceGrantResult> {
  const gateUrl = args.gateUrl.replace(/\/$/, "");
  const overallTimeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const codeRes = await requestDeviceCode(gateUrl, args.hostname);

  args.onCodeIssued?.({
    userCode: codeRes.user_code,
    verificationUri: codeRes.verification_uri,
    verificationUriComplete: codeRes.verification_uri_complete,
    expiresInSec: codeRes.expires_in,
  });

  if (args.openBrowser !== false) {
    open(codeRes.verification_uri_complete).catch(() => {
      // Non-fatal — the caller printed the URL via onCodeIssued.
    });
  }

  return pollForToken({
    gateUrl,
    deviceCode: codeRes.device_code,
    intervalSec: codeRes.interval,
    expiresInSec: codeRes.expires_in,
    overallTimeoutMs,
  });
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function requestDeviceCode(
  gateUrl: string,
  hostname: string,
): Promise<DeviceCodeResponse> {
  let res: Response;
  try {
    res = await fetch(`${gateUrl}/v1/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "chest-cli", hostname }),
    });
  } catch (err) {
    throw new DeviceGrantError(
      "network",
      `Network error contacting ${gateUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const detail = await safeErrorDetail(res);
    throw new DeviceGrantError(
      "request",
      `Device code request failed (${res.status}): ${detail}`,
    );
  }

  return (await res.json()) as DeviceCodeResponse;
}

interface PollArgs {
  gateUrl: string;
  deviceCode: string;
  intervalSec: number;
  expiresInSec: number;
  overallTimeoutMs: number;
}

async function pollForToken(args: PollArgs): Promise<DeviceGrantResult> {
  const deadline = Date.now() + Math.min(
    args.expiresInSec * 1000,
    args.overallTimeoutMs,
  );
  let intervalMs = args.intervalSec * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let res: Response;
    try {
      res = await fetch(`${args.gateUrl}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: DEVICE_CODE_GRANT,
          device_code: args.deviceCode,
          client_id: "chest-cli",
        }),
      });
    } catch (err) {
      // Transient network error — keep polling until the deadline.
      continue;
    }

    if (res.ok) {
      return (await res.json()) as DeviceGrantResult;
    }

    let body: { error?: string; error_description?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // ignore — fall through to "unknown"
    }

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5_000;
        continue;
      case "access_denied":
        throw new DeviceGrantError(
          "denied",
          "Authorization denied in the browser.",
        );
      case "expired_token":
        throw new DeviceGrantError(
          "expired",
          "Login code expired before authorization. Run `chest-gate login` again.",
        );
      case "invalid_grant":
      case "invalid_request":
      case "unsupported_grant_type":
        throw new DeviceGrantError(
          "request",
          body.error_description || body.error,
        );
      default:
        throw new DeviceGrantError(
          "unknown",
          body.error_description ||
            body.error ||
            `Unexpected ${res.status} from token endpoint`,
        );
    }
  }

  throw new DeviceGrantError(
    "timeout",
    "Timed out waiting for browser authorization.",
  );
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    return body.error_description || body.error || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
