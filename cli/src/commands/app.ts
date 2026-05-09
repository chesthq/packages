import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
import {
  buildManifestObject,
  hashManifest,
  signAppMessage,
} from "@chest-gate/proxy";
import { loadManifest } from "../manifest.js";
import { ensureKeypair } from "../keypair.js";
import { runManageAction } from "../manage.js";

export const appCommand = new Command("app").description(
  "Manage Chest Gate App manifests and publish them to the chest.sh registry",
);

appCommand
  .command("validate")
  .description("Validate an app.md manifest against the schema")
  .argument("[path]", "Path to app.md", "./app.md")
  .action(async (path: string) => {
    const abs = resolve(process.cwd(), path);
    const result = await loadManifest(abs);

    if (!result.ok) {
      console.error(chalk.red(`✗ ${path} failed validation:`));
      for (const err of result.errors) {
        console.error(chalk.gray("  · ") + chalk.yellow(err.path) + chalk.gray(", ") + err.message);
      }
      process.exit(1);
    }

    const m = result.manifest;
    console.log(chalk.green(`✓ ${path} is valid`));
    console.log("");
    console.log(chalk.gray("  name           ") + chalk.white(m.name));
    console.log(chalk.gray("  author         ") + chalk.white(m.author));
    console.log(chalk.gray("  version        ") + chalk.white(m.version));
    console.log(chalk.gray("  description    ") + chalk.white(m.description));
    console.log(chalk.gray("  capabilityTags ") + chalk.white(m.capabilityTags.join(", ")));
    if (m.upstreamGates && m.upstreamGates.length > 0) {
      console.log(chalk.gray("  upstreamGates  ") + chalk.white(m.upstreamGates.join(", ")));
    }
    if (m.homepage) console.log(chalk.gray("  homepage       ") + chalk.white(m.homepage));
    if (m.repository) console.log(chalk.gray("  repository     ") + chalk.white(m.repository));
    if (m.license) console.log(chalk.gray("  license        ") + chalk.white(m.license));
    console.log(chalk.gray("  body           ") + chalk.white(`${m.body.length} chars of markdown`));
    console.log("");
    console.log(
      chalk.gray("Note: ") +
        chalk.gray(
          "payout wallet is resolved from the on-chain author record at publish time, not declared in app.md.",
        ),
    );
  });

const KINDS = ["skill", "plugin", "mcp"] as const;
type Kind = (typeof KINDS)[number];

interface PublishManifest {
  slug: string;
  name: string;
  kind: Kind;
  tagline: string;
  description?: string | null;
  readme?: string | null;
  endpointsCsv: string;
  version: string;
  sourceUrl?: string | null;
  homepageUrl?: string | null;
  installJson?: unknown;
}

/** Match server-side canonicalization: lowercase, trim, dedupe, no whitespace. */
function canonicalizeEndpointsCsv(input: string): string {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ).join(",");
}

const DEFAULT_SERVER = process.env.CHEST_SERVER || "https://gate.chest.sh";
const DASHBOARD_BASE = process.env.CHEST_DASHBOARD || "https://chest.sh";

appCommand
  .command("publish")
  .description("Publish an app to the chest.sh registry (signed with ~/.chest/wallet.json)")
  .requiredOption("-m, --manifest <path>", "Path to a JSON manifest with the app fields (see below)")
  .option("--server <url>", "chest.sh API origin", DEFAULT_SERVER)
  .option(
    "--wallet-key <path>",
    "Path to Solana keypair JSON for the author wallet (signs the publish). " +
      "Fallback: CHEST_WALLET_KEY_PATH env, CHEST_WALLET_KEY inline JSON, " +
      "or ~/.chest/wallet.json (same wallet `chest-gate keypair` writes).",
  )
  .option("--dry-run", "Print the canonical manifest hash + signature without POSTing")
  .addHelpText(
    "after",
    `
Manifest JSON shape (file passed via --manifest):

  {
    "slug": "my-skill",                 // ^[a-z0-9][a-z0-9-]{1,63}$
    "name": "My Skill",
    "kind": "skill",                    // "skill" | "plugin" | "mcp"
    "tagline": "One-line summary",
    "description": null,                // long form, optional
    "readme": "# My Skill\\n...",        // markdown, optional
    "endpointsCsv": "smoke-1234,gate-foo", // comma-separated GATE slugs
    "version": "0.1.0",
    "sourceUrl": "https://github.com/me/my-skill",
    "homepageUrl": null,
    "installJson": { ... }              // any JSON, optional
  }

The author wallet (~/.chest/wallet.json by default) signs the canonical
message "chest-app/v4:{author}:{slug}:{manifestHash}:{version}:{windowTs}"
and the server binds the slug to that pubkey on first publish.
`,
  )
  .action(async (opts: { manifest: string; server: string; walletKey?: string; dryRun?: boolean }) => {
    console.log(chalk.bold("\n  ⚡ Chest App Publish\n"));

    const manifestPath = resolve(process.cwd(), opts.manifest);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (err) {
      console.error(chalk.red(`  Error: cannot read ${opts.manifest}: ${(err as Error).message}`));
      process.exit(1);
    }

    let parsed: PublishManifest;
    try {
      parsed = JSON.parse(raw) as PublishManifest;
    } catch (err) {
      console.error(chalk.red(`  Error: ${opts.manifest} is not valid JSON: ${(err as Error).message}`));
      process.exit(1);
    }

    const errs: string[] = [];
    if (typeof parsed.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(parsed.slug)) {
      errs.push("slug must match ^[a-z0-9][a-z0-9-]{1,63}$");
    }
    if (typeof parsed.name !== "string" || !parsed.name.trim()) errs.push("name is required");
    if (!(KINDS as readonly string[]).includes(parsed.kind)) {
      errs.push(`kind must be one of: ${KINDS.join(", ")}`);
    }
    if (typeof parsed.tagline !== "string" || !parsed.tagline.trim()) errs.push("tagline is required");
    if (typeof parsed.endpointsCsv !== "string" || !parsed.endpointsCsv.trim()) {
      errs.push("endpointsCsv is required (comma-separated gate slugs)");
    }
    if (typeof parsed.version !== "string" || !parsed.version.trim()) errs.push("version is required");
    if (errs.length > 0) {
      console.error(chalk.red("  Manifest failed validation:"));
      for (const e of errs) console.error(chalk.gray("  · ") + e);
      process.exit(1);
    }

    let secretKey: Uint8Array;
    if (process.env.CHEST_WALLET_KEY) {
      try {
        secretKey = new Uint8Array(JSON.parse(process.env.CHEST_WALLET_KEY));
      } catch {
        console.error(chalk.red("  Error: CHEST_WALLET_KEY must be a JSON array of 64 bytes"));
        process.exit(1);
      }
    } else if (opts.walletKey || process.env.CHEST_WALLET_KEY_PATH) {
      const path = (opts.walletKey || process.env.CHEST_WALLET_KEY_PATH)!.replace(
        /^~/,
        process.env.HOME || "",
      );
      const raw = await readFile(path, "utf-8");
      secretKey = new Uint8Array(JSON.parse(raw));
    } else {
      const local = await ensureKeypair();
      secretKey = local.keypair;
    }
    const authorWallet = Keypair.fromSecretKey(secretKey).publicKey.toBase58();

    const slugClean = parsed.slug.toLowerCase();
    const versionClean = parsed.version.trim();
    const endpointsCanonical = canonicalizeEndpointsCsv(parsed.endpointsCsv);
    if (!endpointsCanonical) {
      console.error(chalk.red("  Error: endpointsCsv must contain at least one non-empty slug"));
      process.exit(1);
    }
    if (endpointsCanonical !== parsed.endpointsCsv) {
      console.log(
        chalk.gray("  endpointsCsv canonicalized: ") +
          chalk.gray(parsed.endpointsCsv) +
          chalk.gray(" → ") +
          chalk.white(endpointsCanonical),
      );
    }

    const manifestFields = {
      name: parsed.name.trim(),
      kind: parsed.kind,
      tagline: parsed.tagline.trim(),
      description: parsed.description ?? null,
      readme: parsed.readme ?? null,
      endpointsCsv: endpointsCanonical,
      sourceUrl: parsed.sourceUrl ?? null,
      homepageUrl: parsed.homepageUrl ?? null,
      installJson: parsed.installJson ?? null,
    };
    const manifestHashHex = hashManifest(manifestFields);
    const sigBase64 = signAppMessage(
      { author: authorWallet, slug: slugClean, manifestHash: manifestHashHex, version: versionClean },
      secretKey,
    );

    console.log(chalk.gray("  Slug:           ") + chalk.white(slugClean));
    console.log(chalk.gray("  Version:        ") + chalk.white(versionClean));
    console.log(chalk.gray("  Author wallet:  ") + chalk.cyan(authorWallet));
    console.log(chalk.gray("  Manifest hash:  ") + chalk.gray(manifestHashHex));
    console.log(chalk.gray("  Server:         ") + chalk.gray(opts.server));
    console.log();

    if (opts.dryRun) {
      console.log(chalk.yellow("  --dry-run set, skipping POST."));
      console.log(chalk.gray("  X-App-Sig: ") + chalk.gray(sigBase64));
      return;
    }

    try {
      const res = await fetch(`${opts.server}/api/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Sig": sigBase64 },
        body: JSON.stringify({
          slug: slugClean,
          name: manifestFields.name,
          kind: manifestFields.kind,
          tagline: manifestFields.tagline,
          description: manifestFields.description,
          readme: manifestFields.readme,
          authorWallet,
          endpointsCsv: manifestFields.endpointsCsv,
          version: versionClean,
          sourceUrl: manifestFields.sourceUrl,
          homepageUrl: manifestFields.homepageUrl,
          installJson: manifestFields.installJson,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        console.error(chalk.red(`  Error ${res.status}: ${body.error ?? res.statusText}`));
        if (res.status === 403 && typeof body.error === "string" && body.error.includes("different wallet")) {
          console.error(
            chalk.gray(`  Slug "${slugClean}" is already published by another wallet. Pick a new slug.`),
          );
        }
        process.exit(1);
      }
      const created = (body as { created?: boolean }).created;
      console.log(chalk.green(created ? "  ✓ Published" : "  ✓ Updated"));
      console.log(chalk.gray("    Listing: ") + chalk.cyan(`${DASHBOARD_BASE}/apps/${slugClean}`));
    } catch (err) {
      console.error(chalk.red(`  Error: could not reach ${opts.server}: ${(err as Error).message}`));
      process.exit(1);
    }
  });

appCommand
  .command("archive")
  .description("Archive a published app (soft-delete; hides from listings).")
  .argument("<slug>", "App slug to archive")
  .option("--server <url>", "chest.sh API origin", DEFAULT_SERVER)
  .option("--wallet-key <path>", "Path to keypair JSON. Defaults to ~/.chest/wallet.json.")
  .action(async (slug: string, opts: { server: string; walletKey?: string }) => {
    console.log(chalk.bold("\n  ⚡ Chest App Archive\n"));
    await runManageAction({ kind: "app", op: "archive", slug, server: opts.server, walletKey: opts.walletKey });
  });

appCommand
  .command("unlist")
  .description("Toggle the unlisted flag on a published app (use --relist to undo).")
  .argument("<slug>", "App slug")
  .option("--relist", "Re-list (clears the unlisted flag)")
  .option("--server <url>", "chest.sh API origin", DEFAULT_SERVER)
  .option("--wallet-key <path>", "Path to keypair JSON. Defaults to ~/.chest/wallet.json.")
  .action(
    async (slug: string, opts: { relist?: boolean; server: string; walletKey?: string }) => {
      console.log(chalk.bold("\n  ⚡ Chest App Unlist\n"));
      await runManageAction({
        kind: "app",
        op: "unlist",
        slug,
        server: opts.server,
        walletKey: opts.walletKey,
        unlisted: !opts.relist,
      });
    },
  );
