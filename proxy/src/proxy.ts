import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { FreebieTracker } from "./freebie.js";
import { TransactionStore } from "./db.js";
import { matchRoute } from "./routes.js";
import { createFacilitator, type ChestFacilitator } from "./facilitator.js";
import { createSessionConfig, createSessionToken, verifySessionToken, extractSessionCookie, buildSetCookieHeader, type SessionConfig } from "./session.js";
import { computeSplitAmounts, callDistribute } from "./splitter.js";
import { resolveReferrer } from "./referrer.js";
import type { ProxyHooks, RequestEvent, SettledEvent } from "./hooks.js";
import chalk from "chalk";

export interface RouteConfig {
  path: string;
  price: number;
}

export interface ProxyConfig {
  name: string;
  upstream: string;
  wallet: string;
  network: string;
  port: number;
  freebie: number;
  defaultPrice: number;
  routes: RouteConfig[];
  feePayerKeypair: Uint8Array;
  /** Session duration in seconds after payment (default: 3600 = 1 hour). Set to 0 to disable sessions. */
  sessionDuration?: number;
  /** Split configuration for revenue sharing. */
  split?: {
    referrerBps: number;
    protocolBps: number;
    splitConfigPda: string;
    protocolWallet: string;
    merchantTokenAccount: string;
    protocolTokenAccount: string;
    /** Accept X-Referrer-Wallet without signature verification. Default: false. */
    allowUnsignedReferrers?: boolean;
  };
  /**
   * In-process lifecycle hooks. Run synchronously with the request flow,
   * `onRequest` is awaited and can throw to abort with 403; `onSettled` is
   * fire-and-forget and never blocks the response. See `./hooks.ts`.
   *
   * For delivery-guaranteed event handling (push to backend, Slack, refund
   * logic), register a webhook instead.
   */
  hooks?: ProxyHooks;
}

export interface ProxyServer {
  close: () => void;
}

export async function createProxy(config: ProxyConfig): Promise<ProxyServer> {
  const app = new Hono();
  const freebieTracker = new FreebieTracker(config.freebie);
  const store = new TransactionStore();

  // Session config, pay once, access for N seconds
  const sessionEnabled = (config.sessionDuration ?? 3600) > 0;
  const sessionConfig = sessionEnabled
    ? createSessionConfig({ durationSeconds: config.sessionDuration ?? 3600 })
    : null;

  // Initialise the in-process x402 facilitator
  let facilitator: ChestFacilitator;
  try {
    facilitator = await createFacilitator(config.feePayerKeypair, config.network);
  } catch (err) {
    throw new Error(`Failed to initialise facilitator: ${(err as Error).message}`);
  }

  // Health endpoint for the proxy itself
  app.get("/__chest/health", (c) => {
    return c.json({
      status: "ok",
      version: "0.1.0",
      feePayer: facilitator.feePayer,
      network: config.network,
    });
  });

  // Stats endpoint
  app.get("/__chest/stats", (c) => {
    const stats = store.getStats();
    return c.json(stats);
  });

  // Dashboard, self-contained HTML page at /__chest/dashboard
  app.get("/__chest/dashboard", (c) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chest Gate, Dashboard</title>
<style>
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff; --purple: #bc8cff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; font-size: 14px; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 6px; }
  .card-value { font-size: 24px; font-weight: 700; }
  .card-value.green { color: var(--green); }
  .card-value.blue { color: var(--blue); }
  .card-value.purple { color: var(--purple); }
  .card-value.yellow { color: var(--yellow); }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: var(--bg); border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.settled { background: #1a2f1a; color: var(--green); }
  .badge.failed { background: #2f1a1a; color: var(--red); }
  .badge.pending { background: #2a2a1a; color: var(--yellow); }
  .badge.distributed { background: #1a1a2f; color: var(--purple); }
  .mono { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .refresh-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; float: right; }
  .refresh-btn:hover { border-color: var(--blue); color: var(--blue); }
  #error { color: var(--red); padding: 16px; }
  .section { margin-bottom: 32px; }
  /* Skeleton shimmer */
  @keyframes shimmer {
    0% { background-position: -600px 0; }
    100% { background-position: 600px 0; }
  }
  .sk {
    background: linear-gradient(90deg, var(--surface) 25%, #1e2530 50%, var(--surface) 75%);
    background-size: 600px 100%;
    animation: shimmer 1.4s ease-in-out infinite;
    border-radius: 4px;
    display: inline-block;
  }
  .sk-card-label { height: 10px; width: 70%; margin-bottom: 10px; }
  .sk-card-value { height: 28px; width: 55%; }
  .sk-td-short { height: 12px; width: 60px; }
  .sk-td-mid { height: 12px; width: 110px; }
  .sk-td-long { height: 12px; width: 160px; }
  .sk-td-badge { height: 18px; width: 64px; border-radius: 4px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
  <div>
    <h1>Chest Gate</h1>
    <div class="subtitle" id="updated"><span class="sk" style="height:12px;width:180px;"></span></div>
  </div>
  <button class="refresh-btn" onclick="load()">↻ Refresh</button>
</div>
<div id="content">
  <div class="grid">
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
    <div class="card"><div class="sk sk-card-label"></div><div class="sk sk-card-value"></div></div>
  </div>
  <div class="section">
    <h2><span class="sk" style="height:10px;width:80px;"></span></h2>
    <table><tr><th></th><th></th><th></th></tr>
      <tr><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-short"></span></td></tr>
    </table>
  </div>
  <div class="section">
    <h2><span class="sk" style="height:10px;width:100px;"></span></h2>
    <table><tr><th></th><th></th><th></th></tr>
      <tr><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-short"></span></td></tr>
    </table>
  </div>
  <div class="section">
    <h2><span class="sk" style="height:10px;width:140px;"></span></h2>
    <table><tr><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr>
      <tr><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-short"></span></td></tr>
      <tr><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-long"></span></td><td><span class="sk sk-td-short"></span></td><td><span class="sk sk-td-mid"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-badge"></span></td><td><span class="sk sk-td-short"></span></td></tr>
    </table>
  </div>
</div>
<div id="error"></div>

<script>
function fmt(n, decimals=4) {
  if (n == null) return '·';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
function fmtUsd(n) {
  if (n == null) return '·';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
function short(s) {
  if (!s) return '·';
  return s.length > 16 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
}
function badge(state) {
  if (!state) return '';
  const cls = state.toLowerCase().includes('settled') || state === 'SETTLED' ? 'settled'
    : state.toLowerCase().includes('fail') ? 'failed'
    : state.toLowerCase().includes('distribut') ? 'distributed'
    : 'pending';
  return '<span class="badge ' + cls + '">' + state + '</span>';
}
const SKELETON = document.getElementById('content').innerHTML;
async function load() {
  document.getElementById('content').innerHTML = SKELETON;
  document.getElementById('updated').innerHTML = '<span class="sk" style="height:12px;width:180px;"></span>';
  try {
    const r = await fetch('/__chest/stats');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    document.getElementById('error').textContent = '';
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

    const content = \`
      <div class="grid">
        <div class="card"><div class="card-label">Total Revenue</div><div class="card-value green">\${fmtUsd(d.totalRevenue)}</div></div>
        <div class="card"><div class="card-label">Merchant Revenue</div><div class="card-value green">\${fmtUsd(d.merchantRevenue)}</div></div>
        <div class="card"><div class="card-label">Referrer Revenue</div><div class="card-value blue">\${fmtUsd(d.referrerRevenue)}</div></div>
        <div class="card"><div class="card-label">Protocol Revenue</div><div class="card-value purple">\${fmtUsd(d.protocolRevenue)}</div></div>
        <div class="card"><div class="card-label">Settled Txns</div><div class="card-value">\${d.settledTransactions} <span style="font-size:14px;color:var(--muted)">/ \${d.totalTransactions}</span></div></div>
        <div class="card"><div class="card-label">Unique Payers</div><div class="card-value yellow">\${d.uniquePayers}</div></div>
        <div class="card"><div class="card-label">Unique Referrers</div><div class="card-value blue">\${d.uniqueReferrers}</div></div>
      </div>

      <div class="section">
        <h2>Top Routes</h2>
        <table>
          <tr><th>Route</th><th>Calls</th><th>Revenue</th></tr>
          \${(d.topRoutes || []).map(r => \`<tr><td class="mono">\${r.route}</td><td>\${r.count}</td><td>\${fmtUsd(r.revenue)}</td></tr>\`).join('') || '<tr><td colspan="3" class="muted">No data</td></tr>'}
        </table>
      </div>

      <div class="section">
        <h2>Top Referrers</h2>
        <table>
          <tr><th>Wallet</th><th>Calls</th><th>Earned</th></tr>
          \${(d.topReferrers || []).map(r => \`<tr><td class="mono">\${short(r.referrer)}</td><td>\${r.count}</td><td>\${fmtUsd(r.earned)}</td></tr>\`).join('') || '<tr><td colspan="3" class="muted">No referrals yet</td></tr>'}
        </table>
      </div>

      <div class="section">
        <h2>Recent Transactions</h2>
        <table>
          <tr><th>ID</th><th>Payer</th><th>Route</th><th>Amount</th><th>Referrer</th><th>State</th><th>Distribute</th><th>Time</th></tr>
          \${(d.recentTransactions || []).map(tx => \`
            <tr>
              <td class="muted">#\${tx.id}</td>
              <td class="mono">\${short(tx.payerWallet)}</td>
              <td class="mono">\${tx.route}</td>
              <td>\${fmtUsd(tx.amountUsdc)}</td>
              <td class="mono">\${tx.referrerWallet ? short(tx.referrerWallet) : '<span class="muted">·</span>'}</td>
              <td>\${badge(tx.state)}</td>
              <td>\${badge(tx.distributeState)}</td>
              <td class="muted">\${tx.createdAt ? new Date(tx.createdAt).toLocaleTimeString() : '·'}</td>
            </tr>
          \`).join('') || '<tr><td colspan="8" class="muted">No transactions</td></tr>'}
        </table>
      </div>
    \`;
    document.getElementById('content').innerHTML = content;
  } catch (e) {
    document.getElementById('error').textContent = 'Error loading stats: ' + e.message;
  }
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`;
    return c.html(html);
  });

  // Discovery endpoint for agent referral commission rates
  app.get("/.well-known/chest.json", (c) => {
    if (!config.split) {
      return c.json({ x402: true, split: false }, 200);
    }

    return c.json({
      x402: true,
      network: config.network,
      splitter: config.split.splitConfigPda,
      referrerCommission: `${config.split.referrerBps / 100}%`,
      protocolFee: `${config.split.protocolBps / 100}%`,
      price: `$${config.defaultPrice}`,
      referrerHeader: "X-Referrer-Wallet",
      referrerSigHeader: "X-Referrer-Sig",
      referrerSigNote: "ed25519 over: chest-referral:{signerPubkey}[:{payoutWallet}]:{slug}:{amountMicros}:{windowTs}",
      referrerPayoutHeader: "X-Referrer-Payout",
      referrerPayoutNote: "optional cold wallet for payout; must be committed inside the signature",
      allowUnsignedReferrers: config.split.allowUnsignedReferrers ?? false,
    });
  });

  // All other requests go through the payment gate
  app.all("*", async (c) => {
    const method = c.req.method;
    const path = c.req.path;
    const clientIp = c.req.header("x-forwarded-for") || "unknown";

    // Match route to determine price
    const route = matchRoute(method, path, config.routes);
    const price = route?.price ?? config.defaultPrice;

    // Free passthrough for $0 routes
    if (price === 0) {
      return forwardToUpstream(c, config.upstream);
    }

    // Check for valid session cookie (pay once, access for N minutes)
    if (sessionConfig) {
      const cookieHeader = c.req.header("cookie") ?? null;
      const token = extractSessionCookie(sessionConfig, cookieHeader);
      if (token) {
        const session = await verifySessionToken(sessionConfig, token);
        if (session) {
          console.log(
            chalk.blue("  ● Session") +
            chalk.gray(` [${new Date().toLocaleTimeString()}]`) +
            chalk.gray(` ${method} ${path}`) +
            chalk.gray(` payer:${session.payer.slice(0, 8)}...`) +
            chalk.gray(` expires:${new Date(session.exp * 1000).toLocaleTimeString()}`)
          );
          return forwardToUpstream(c, config.upstream);
        }
      }
    }

    // Check freebie allowance
    if (freebieTracker.hasFreebies(clientIp)) {
      freebieTracker.use(clientIp);
      const remaining = freebieTracker.remaining(clientIp);
      console.log(
        chalk.gray(`  ○ Freebie`) +
        chalk.gray(` [${new Date().toLocaleTimeString()}]`) +
        chalk.gray(` ${method} ${path}`) +
        chalk.gray(` (${remaining} remaining for ${clientIp})`)
      );
      return forwardToUpstream(c, config.upstream);
    }

    // Check for x402 payment header
    const paymentHeader = c.req.header("x-payment");

    if (!paymentHeader) {
      // Build proper x402 payment requirements using the facilitator.
      // When split is configured, payTo = split_config_pda so x402 derives
      // ATA(split_config_pda, mint) = vault. Funds land trustlessly in vault.
      const requirements = facilitator.buildPaymentRequirements({
        price,
        wallet: config.wallet,
        network: config.network,
        route: `${method} ${path}`,
        payToOverride: config.split?.splitConfigPda,
      });

      // Wrap in PaymentRequired envelope (x402 protocol format)
      const paymentRequired = {
        x402Version: 2,
        accepts: [requirements],
        resource: {
          url: `${method} ${path}`,
          contentType: "application/json",
        },
      };

      return c.json(paymentRequired, 402, {
        "X-Payment-Required": "true",
      });
    }

    // Parse the payment payload from the header
    let payload;
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    } catch {
      return c.json({ error: "Invalid payment header, expected base64-encoded JSON" }, 400);
    }

    // Build the requirements for verification (must match what was sent in 402)
    const requirements = facilitator.buildPaymentRequirements({
      price,
      wallet: config.wallet,
      network: config.network,
      route: `${method} ${path}`,
      payToOverride: config.split?.splitConfigPda,
    });

    // Verify the payment
    const verification = await facilitator.verify(payload, requirements);

    if (!verification.isValid) {
      return c.json(
        {
          error: "Payment verification failed",
          reason: verification.invalidReason,
        },
        402
      );
    }

    // Extract payer address from the verification result or payload
    const payerWallet = (verification as any).payer
      || payload.payload?.clientAddress
      || payload.clientAddress
      || clientIp;

    // Resolve referrer once, upfront. The hook below and the split
    // distribute crank below both consume it. resolveReferrer is cheap
    // (header parse + ed25519 verify); doing it here avoids a second pass.
    const resolvedReferrer = config.split
      ? resolveReferrer(
          (h) => c.req.header(h),
          config.name,
          parseInt(requirements.amount, 10),
          { allowUnsigned: config.split.allowUnsignedReferrers },
        )
      : resolveReferrer(
          (h) => c.req.header(h),
          config.name,
          parseInt(requirements.amount, 10),
          { allowUnsigned: false },
        );
    const referrerWallet = resolvedReferrer?.payoutWallet ?? null;

    // Fire onRequest hook. Awaited inline; throwing aborts the call with 403.
    if (config.hooks?.onRequest) {
      const ev: RequestEvent = {
        gateSlug: config.name,
        method,
        path,
        matchedRoute: route?.path ?? null,
        priceUsd: price,
        referrerWallet,
        payerWallet,
      };
      try {
        await config.hooks.onRequest(ev);
      } catch (err) {
        const reason = (err as Error).message ?? "Hook rejected";
        console.log(chalk.yellow("  ⚠ onRequest aborted") + chalk.gray(` ${method} ${path}, ${reason}`));
        return c.json({ error: "Forbidden", reason }, 403);
      }
    }

    // Record pending transaction
    const txId = store.recordPending(payerWallet, `${method} ${path}`, price, clientIp);

    // Forward to upstream
    const response = await forwardToUpstream(c, config.upstream);

    // Settle the payment on-chain
    const settlement = await facilitator.settle(payload, requirements);

    if (settlement.success) {
      store.markSettled(txId, settlement.txSignature || "");

      // Compute amounts upfront, used by both the onSettled hook (predicted
      // split values) and the distribute crank below (actual on-chain split).
      const amountAtomic = parseInt(requirements.amount, 10);
      const hasReferrer = !!referrerWallet;
      const splitAmounts = config.split
        ? computeSplitAmounts(
            amountAtomic,
            config.split.referrerBps,
            config.split.protocolBps,
            hasReferrer,
          )
        : { merchant: amountAtomic, referrer: 0, protocol: 0 };

      // Fire onSettled hook. Fire-and-forget; errors logged but never block.
      if (config.hooks?.onSettled) {
        const ev: SettledEvent = {
          gateSlug: config.name,
          method,
          path,
          matchedRoute: route?.path ?? null,
          priceUsd: price,
          referrerWallet,
          payerWallet,
          txSignature: settlement.txSignature || "",
          settledAt: new Date().toISOString(),
          amounts: {
            totalUsd: amountAtomic / 1e6,
            providerUsd: splitAmounts.merchant / 1e6,
            referrerUsd: splitAmounts.referrer / 1e6,
            protocolUsd: splitAmounts.protocol / 1e6,
          },
        };
        Promise.resolve(config.hooks.onSettled(ev)).catch((err) => {
          console.error(chalk.red("  ✗ onSettled hook error: ") + chalk.gray((err as Error).message));
        });
      }

      // Distribute split if configured
      if (config.split && settlement.success) {
        const claimedReferrer = c.req.header("x-referrer-wallet");

        if (claimedReferrer && !referrerWallet) {
          console.log(
            chalk.yellow("  ⚠ Referrer sig invalid") +
            chalk.gray(` wallet:${claimedReferrer.slice(0, 8)}..., commission denied`)
          );
        } else if (resolvedReferrer && !resolvedReferrer.verified) {
          console.log(
            chalk.yellow("  ⚠ Referrer unsigned") +
            chalk.gray(` payout:${referrerWallet!.slice(0, 8)}..., allowed by merchant config`)
          );
        }

        store.markDistributePending(
          txId,
          referrerWallet,
          splitAmounts.merchant / 1e6,
          splitAmounts.referrer / 1e6,
          splitAmounts.protocol / 1e6
        );

        // Fire-and-forget distribute crank
        callDistribute({
          feePayerKeypair: config.feePayerKeypair,
          splitConfigPda: config.split.splitConfigPda,
          merchantTokenAccount: config.split.merchantTokenAccount,
          protocolTokenAccount: config.split.protocolTokenAccount,
          referrerTokenAccount: referrerWallet,
          usdcMint: requirements.asset,
          amount: amountAtomic,
          referrerBps: config.split.referrerBps,
          protocolBps: config.split.protocolBps,
          hasReferrer,
          network: config.network,
        }).then((result) => {
          if (result.success) {
            store.markDistributed(txId, result.txSignature || "");
            console.log(
              chalk.green("  ↔ Split") +
              chalk.gray(` merchant:$${(splitAmounts.merchant / 1e6).toFixed(5)}`) +
              chalk.gray(` referrer:$${(splitAmounts.referrer / 1e6).toFixed(5)}`) +
              chalk.gray(` protocol:$${(splitAmounts.protocol / 1e6).toFixed(5)}`)
            );
          } else {
            store.markDistributeFailed(txId, result.error || "Unknown");
            console.log(chalk.red("  ✗ Distribute failed: ") + chalk.gray(result.error));
          }
        }).catch((err) => {
          store.markDistributeFailed(txId, (err as Error).message);
        });
      }

      // Console log the payment
      const timestamp = new Date().toLocaleTimeString();
      console.log(
        chalk.green("  ✓ Payment") +
        chalk.gray(` [${timestamp}]`) +
        chalk.white(` $${price}`) +
        chalk.gray(` from `) +
        chalk.cyan(payerWallet.slice(0, 8) + "...") +
        chalk.gray(` → ${method} ${path}`) +
        chalk.gray(` tx:${settlement.txSignature?.slice(0, 12)}...`)
      );
    } else {
      store.markFailed(txId, settlement.error || "Settlement failed");

      console.log(
        chalk.red("  ✗ Settlement failed") +
        chalk.gray(` ${method} ${path}`) +
        chalk.gray(`, ${settlement.error}`)
      );
    }

    // Add payment receipt to response headers
    const responseHeaders: Record<string, string> = {
      "x-chest-proxy": "true",
    };

    if (settlement.txSignature) {
      responseHeaders["x-payment-response"] = Buffer.from(
        JSON.stringify({
          txSignature: settlement.txSignature,
          payer: payerWallet,
          amount: price,
          network: config.network,
        })
      ).toString("base64");
    }

    // Issue session cookie, subsequent requests skip payment
    if (sessionConfig && settlement.success) {
      const sessionToken = await createSessionToken(sessionConfig, payerWallet, `${method} ${path}`);
      responseHeaders["set-cookie"] = buildSetCookieHeader(sessionConfig, sessionToken);

      const durationMin = Math.round((config.sessionDuration ?? 3600) / 60);
      console.log(
        chalk.blue("  ● Session issued") +
        chalk.gray(` ${durationMin}min for ${payerWallet.slice(0, 8)}...`)
      );
    }

    const body = await response.text();
    const status = response.status as 200;
    return c.body(body, status, responseHeaders);
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({
      fetch: app.fetch,
      port: config.port,
    });

    (s as any).on?.("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(
          `Port ${config.port} is already in use. Either:\n` +
          `  1. Kill the process: lsof -ti:${config.port} | xargs kill -9\n` +
          `  2. Use a different port: --port ${config.port + 1}`
        ));
      } else {
        reject(err);
      }
    });

    setTimeout(() => resolve(s), 200);
  });

  return {
    close: () => {
      server.close();
      store.close();
    },
  };
}

async function forwardToUpstream(c: any, upstream: string): Promise<Response> {
  const url = new URL(c.req.path, upstream);

  const reqUrl = new URL(c.req.url);
  url.search = reqUrl.search;

  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      if (
        key.toLowerCase() !== "host" &&
        key.toLowerCase() !== "x-payment" &&
        key.toLowerCase() !== "x-payment-required"
      ) {
        headers.set(key, value as string);
      }
    }

    const response = await fetch(url.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD"
        ? await c.req.raw.text()
        : undefined,
    });

    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Upstream unavailable", detail: String(err) }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}
