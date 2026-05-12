import { Command } from "commander";
import chalk from "chalk";
import { paidFetch, type PaidFetchMode } from "@chest-gate/sdk";

interface CallOptions {
  method?: string;
  header?: string[];
  data?: string;
  app?: string;
  referrer?: string;
  referrerKey?: string;
  agentToken?: string;
  mode?: string;
  gateUrl?: string;
  raw?: boolean;
  json?: boolean;
}

export const callCommand = new Command("call")
  .description("Pay an x402 gate and print the response. Uses the wallet from `chest-gate login`, CHEST_AGENT_TOKEN, or ~/.chest/agent-keypair.json (auto-detected).")
  .argument("<url>", "Gate URL to call, e.g. https://gate.chest.sh/g/<slug>/<endpoint>")
  .option("-X, --method <verb>", "HTTP method", "GET")
  .option("-H, --header <header>", "Extra header (repeatable), e.g. -H 'accept: application/json'", collect, [] as string[])
  .option("-d, --data <body>", "Request body. Prefix with @ to read from a file, or use - for stdin.")
  .option("--app <slug>", "Forward x-chest-app=<slug> so the gate attributes the referrer cut.")
  .option("--referrer <wallet>", "Forward x-referrer-wallet (overrides --app for attribution).")
  .option("--referrer-key <key>", "Referrer key cg_pub_… (or set CHEST_REFERRER_KEY). Forwarded as X-Chest-Referrer-Key.")
  .option("--agent-token <token>", "Agent token ca_live_… (or set CHEST_AGENT_TOKEN). Overrides login credentials.")
  .option("--mode <mode>", "Credential mode: auto | agent-token | privy | local", "auto")
  .option("--gate-url <url>", "Override the chest.sh API URL used to co-sign payments.")
  .option("--raw", "Print only the response body (no receipt footer).")
  .option("--json", "Print { body, receipt, payer, mode } as JSON.")
  .action(async (url: string, opts: CallOptions) => {
    if (!/^https?:\/\//i.test(url)) {
      fail(opts, `URL must start with http(s)://, got: ${url}`);
    }

    const mode = (opts.mode ?? "auto") as PaidFetchMode;
    if (!["auto", "agent-token", "privy", "local"].includes(mode)) {
      fail(opts, `Invalid --mode: ${mode}. Expected auto, agent-token, privy, or local.`);
    }

    const headers = new Headers();
    for (const h of opts.header ?? []) {
      const idx = h.indexOf(":");
      if (idx < 0) fail(opts, `Bad header (missing colon): ${h}`);
      headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
    }

    const method = (opts.method ?? "GET").toUpperCase();
    const body = await readBody(opts.data);
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    try {
      const result = await paidFetch(url, {
        init: { method, headers, body },
        mode,
        agentToken: opts.agentToken,
        referrerKey: opts.referrerKey,
        appSlug: opts.app,
        referrerWallet: opts.referrer,
        chestApi: opts.gateUrl,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }

      const bodyOut =
        typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
      process.stdout.write(bodyOut + "\n");

      if (opts.raw) return;

      process.stderr.write("\n");
      process.stderr.write(chalk.gray("  Paid via ") + chalk.white(result.mode));
      if (result.payer) {
        process.stderr.write(chalk.gray(" · payer ") + chalk.cyan(result.payer));
      }
      if (result.receipt?.amount) {
        process.stderr.write(chalk.gray(" · amount ") + chalk.white(String(result.receipt.amount)));
      }
      if (result.receipt?.txSignature) {
        process.stderr.write(chalk.gray(" · tx ") + chalk.white(String(result.receipt.txSignature)));
      }
      process.stderr.write("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
      } else {
        process.stderr.write(chalk.red(`\n  ✗ ${message}\n\n`));
      }
      process.exit(1);
    }
  });

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function readBody(data: string | undefined): Promise<string | undefined> {
  if (data === undefined) return undefined;
  if (data === "-") {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
  }
  if (data.startsWith("@")) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(data.slice(1), "utf-8");
  }
  return data;
}

function fail(opts: CallOptions, message: string): never {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    process.stderr.write(chalk.red(`\n  ✗ ${message}\n\n`));
  }
  process.exit(1);
}
