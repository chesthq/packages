/**
 * Shared helper for owner-scoped management actions (archive, unlist) used
 * by both `chest-gate gate archive|unlist` and `chest-gate app archive|unlist`.
 *
 * Auth: CLI bearer token (`ca_live_*`), minted by `chest-gate login`. The
 * server checks that the token's owner wallet matches the slug's deployer
 * (gate) or author (app) before mutating. The previous per-action ed25519
 * `X-Dashboard-Sig` flow was removed server-side; sending it now is a
 * silent no-op that fails 401.
 */

import chalk from "chalk";
import { api, ApiError, NotLoggedInError } from "./api.js";

export type ManageKind = "gate" | "app";
export type ManageOp = "archive" | "unlist";

interface ManageOptions {
  kind: ManageKind;
  op: ManageOp;
  slug: string;
  /** Override the gate URL. Default: creds.gateUrl, then CHEST_SERVER. */
  server?: string;
  /** Only used by `unlist`. true → unlisted, false → re-listed. */
  unlisted?: boolean;
}

export async function runManageAction(opts: ManageOptions): Promise<void> {
  const slug = opts.slug.toLowerCase();
  const kindPath = opts.kind === "gate" ? "gates" : "apps";
  const path = `/api/${kindPath}/${encodeURIComponent(slug)}/${opts.op}`;

  console.log(chalk.gray("  Slug:    ") + chalk.white(slug));
  console.log(chalk.gray("  Action:  ") + chalk.white(`${opts.kind}:${opts.op}`));
  console.log();

  try {
    const body =
      opts.op === "unlist" ? { unlisted: opts.unlisted ?? true } : undefined;
    const result = await api<Record<string, unknown>>(path, {
      method: "POST",
      body,
      server: opts.server,
    });

    if (opts.op === "archive") {
      if (result.alreadyArchived) {
        console.log(chalk.yellow(`  Already archived at ${result.archivedAt}`));
        return;
      }
      console.log(chalk.green("  ✓ Archived"));
      if (typeof result.archivedAt === "string") {
        console.log(chalk.gray("    archivedAt: ") + chalk.gray(result.archivedAt));
      }
    } else {
      const unlisted = result.unlisted === true;
      console.log(chalk.green(unlisted ? "  ✓ Unlisted" : "  ✓ Re-listed"));
    }
  } catch (err) {
    handleApiError(err, slug);
    process.exit(1);
  }
}

function handleApiError(err: unknown, slug: string): void {
  if (err instanceof NotLoggedInError) {
    console.error(chalk.red(`  Error: ${err.message}`));
    return;
  }
  if (err instanceof ApiError) {
    console.error(chalk.red(`  Error ${err.status}: ${err.message}`));
    if (err.status === 401) {
      console.error(chalk.gray("  Re-run `chest-gate login` to mint a fresh token."));
    } else if (err.status === 403) {
      console.error(
        chalk.gray(`  Your wallet doesn't own slug "${slug}". Log in with the wallet that deployed/published it.`),
      );
    } else if (err.status === 404) {
      console.error(chalk.gray(`  Slug "${slug}" not found.`));
    }
    return;
  }
  console.error(chalk.red(`  Error: ${(err as Error).message}`));
}
