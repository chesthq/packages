import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDeviceGrant, DeviceGrantError } from "./index.js";

describe("runDeviceGrant — happy path", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  it("requests a code, polls until authorized, returns the token", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/v1/oauth/token") {
        // Two pending polls, then success.
        const callIdx = calls.filter((c) => c.endsWith("/v1/oauth/token")).length;
        if (callIdx < 3) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            token: "ca_live_test",
            ownerWallet: "wallet-1",
            tokenId: "tok-1",
            label: "CLI: host-1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const onCodeIssued = vi.fn();
    const promise = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "host-1",
      openBrowser: false,
      onCodeIssued,
    });

    // Drive the polling interval forward.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.token).toBe("ca_live_test");
    expect(result.ownerWallet).toBe("wallet-1");
    expect(onCodeIssued).toHaveBeenCalledOnce();
    expect(onCodeIssued.mock.calls[0][0].userCode).toBe("WXYZ-PQRS");
    expect(onCodeIssued.mock.calls[0][0].verificationUri).toBe("https://chest.sh/device");
    // device/code + ≥3 token polls.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe("runDeviceGrant — errors", () => {
  const realFetch = global.fetch;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  function tokenResponder(body: object, status = 400): typeof fetch {
    return vi.fn(async (url: any) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("access_denied → DeviceGrantError kind=denied", async () => {
    global.fetch = tokenResponder({ error: "access_denied" });
    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    const err = await captureRejection(p);
    expect(err).toBeInstanceOf(DeviceGrantError);
    expect(err.kind).toBe("denied");
  });

  it("expired_token → DeviceGrantError kind=expired", async () => {
    global.fetch = tokenResponder({ error: "expired_token" });
    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    const err = await captureRejection(p);
    expect(err.kind).toBe("expired");
  });

  it("slow_down increases interval; eventually completes", async () => {
    let polls = 0;
    global.fetch = vi.fn(async (url: any) => {
      const path = new URL(url).pathname;
      if (path === "/v1/oauth/device/code") {
        return new Response(
          JSON.stringify({
            device_code: "x".repeat(43),
            user_code: "WXYZ-PQRS",
            verification_uri: "https://chest.sh/device",
            verification_uri_complete: "https://chest.sh/device?code=WXYZ-PQRS",
            expires_in: 900,
            interval: 1,
          }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls < 2) {
        return new Response(JSON.stringify({ error: "slow_down" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          token: "ca_live_ok",
          ownerWallet: "w",
          tokenId: "t",
          label: "CLI: h",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const p = runDeviceGrant({
      gateUrl: "https://gate.chest.sh",
      hostname: "h",
      openBrowser: false,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.token).toBe("ca_live_ok");
  });

  it("device/code 503 throws kind=request", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "service_unavailable" }), {
        status: 503,
      }),
    ) as typeof fetch;
    const err = await captureRejection(
      runDeviceGrant({
        gateUrl: "https://gate.chest.sh",
        hostname: "h",
        openBrowser: false,
      }),
    );
    expect(err.kind).toBe("request");
  });
});

async function captureRejection(p: Promise<unknown>): Promise<DeviceGrantError> {
  // Attach a catch handler synchronously so the rejection is never "unhandled"
  // when fake timers settle the promise before we await it below.
  const guarded = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e: e as DeviceGrantError }),
  );
  await vi.runAllTimersAsync();
  const outcome = await guarded;
  if (outcome.ok) throw new Error("expected rejection");
  return outcome.e;
}
