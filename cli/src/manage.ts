/**
 * Shared helper for dashboard-signed management actions (archive, unlist).
 * Used by both `chest-gate gate archive|unlist` and `chest-gate app archive|unlist`.
 *
 * Signs `chest-dashboard:{wallet}:{action}:{slug}:{windowTs}` with the
 * deployer/author keypair from ~/.chest/wallet.json (same wallet that signed
 * the original deploy / publish), then POSTs to /api/{kind}/:slug/{op}.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { Keypair } from "@solana/web3.js";
import { signDashboardMessage, type DashboardAction } from "./dashboard-sig.js";

const WALLET_PATH = join(homedir(), ".chest", "wallet.json");
const DEFAULT_SERVER = process.env.CHEST_SERVER || "https://gate.chest.sh";

interface WalletFile {
  solanaKeypair: number[];
}

/**
 * Load the deployer/author secret key. Priority:
 *   1. CHEST_WALLET_KEY env (inline 64-byte JSON array)
 *   2. --wallet-key <path> (raw Solana keypair JSON)
 *   3. ~/.chest/wallet.json (the wallet `chest-gate keypair` writes)
 *
 * Errors if none are present, since management actions can't fall back to
 * creating a fresh wallet (which wouldn't own any existing slug).
 */
async function loadDeployerSecretKey(walletKeyPath?: string): Promise<Uint8Array> {
  const inline = process.env.CHEST_WALLET_KEY;
  if (inline) {
    try {
      return new Uint8Array(JSON.parse(inline));
    } catch {
      throw new Error("CHEST_WALLET_KEY must be a JSON array of 64 bytes");
    }
  }

  const path = walletKeyPath || process.env.CHEST_WALLET_KEY_PATH;
  if (path) {
    const resolved = path.replace(/^~/, process.env.HOME || "");
    return new Uint8Array(JSON.parse(await readFile(resolved, "utf-8")));
  }

  if (!existsSync(WALLET_PATH)) {
    throw new Error(
      `No wallet found at ${WALLET_PATH}. Run \`chest-gate keypair\` (or pass --wallet-key) ` +
        `with the same wallet that signed the original deploy / publish.`,
    );
  }
  const wallet = JSON.parse(await readFile(WALLET_PATH, "utf-8")) as WalletFile;
  return new Uint8Array(wallet.solanaKeypair);
}

export type ManageKind = "gate" | "app";
export type ManageOp = "archive" | "unlist";

interface ManageOptions {
  kind: ManageKind;
  op: ManageOp;
  slug: string;
  server?: string;
  walletKey?: string;
  /** Only used by `unlist`. true → unlisted, false → re-listed. */
  unlisted?: boolean;
}

/**
 * Run a dashboard-signed management action (archive or unlist) against the
 * gate.chest.sh server. The slug must be owned by the loaded keypair.
 */
export async function runManageAction(opts: ManageOptions): Promise<void> {
  const server = (opts.server || DEFAULT_SERVER).replace(/\/$/, "");
  const slug = opts.slug.toLowerCase();
  const kindPath = opts.kind === "gate" ? "gates" : "apps";
  const action: DashboardAction =
    opts.kind === "gate"
      ? opts.op === "archive"
        ? "deployment:archive"
        : "deployment:unlist"
      : opts.op === "archive"
        ? "app:archive"
        : "app:unlist";

  let secretKey: Uint8Array;
  try {
    secretKey = await loadDeployerSecretKey(opts.walletKey);
  } catch (err) {
    console.error(chalk.red(`  Error: ${(err as Error).message}`));
    process.exit(1);
  }
  const wallet = Keypair.fromSecretKey(secretKey).publicKey.toBase58();

  console.log(chalk.gray("  Slug:    ") + chalk.white(slug));
  console.log(chalk.gray("  Wallet:  ") + chalk.cyan(wallet));
  console.log(chalk.gray("  Action:  ") + chalk.white(action));
  console.log(chalk.gray("  Server:  ") + chalk.gray(server));
  console.log();

  const sigBase64 = signDashboardMessage({ wallet, action, resourceId: slug }, secretKey);

  const url = `${server}/api/${kindPath}/${encodeURIComponent(slug)}/${opts.op}?wallet=${encodeURIComponent(wallet)}`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "X-Dashboard-Sig": sigBase64,
      ...(opts.op === "unlist" ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.op === "unlist"
      ? { body: JSON.stringify({ unlisted: opts.unlisted ?? true }) }
      : {}),
  };

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.error(chalk.red(`  Error: could not reach ${server}: ${(err as Error).message}`));
    process.exit(1);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    console.error(chalk.red(`  Error ${res.status}: ${body.error ?? res.statusText}`));
    if (res.status === 403) {
      console.error(
        chalk.gray(
          `  The loaded wallet doesn't own slug "${slug}". Use the same wallet that signed the original deploy / publish.`,
        ),
      );
    } else if (res.status === 404) {
      console.error(chalk.gray(`  Slug "${slug}" not found.`));
    } else if (res.status === 401) {
      console.error(
        chalk.gray(
          "  Signature failed verification. Check that ~/.chest/wallet.json holds the deployer / author key.",
        ),
      );
    }
    process.exit(1);
  }

  if (opts.op === "archive") {
    if (body.alreadyArchived) {
      console.log(chalk.yellow(`  Already archived at ${body.archivedAt}`));
      return;
    }
    console.log(chalk.green("  ✓ Archived"));
    if (typeof body.archivedAt === "string") {
      console.log(chalk.gray("    archivedAt: ") + chalk.gray(body.archivedAt));
    }
  } else {
    const unlisted = body.unlisted === true;
    console.log(chalk.green(unlisted ? "  ✓ Unlisted" : "  ✓ Re-listed"));
  }
}
