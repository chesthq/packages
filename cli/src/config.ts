import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface RouteConfig {
  path: string;
  price: number;
}

/**
 * Discovery metadata for one upstream endpoint. Surfaced on
 * /g/:slug/.well-known/chest.json under `apps.bazaar.endpoints` and on the
 * public gate page. Optional; gates without this declared still work — they
 * just appear without an endpoint list.
 *
 * Distinct from RouteConfig: that one controls per-route *pricing* and is
 * signature-protected by the deploy message; this one is documentation only.
 */
export interface EndpointConfig {
  path: string;
  description?: string;
}

export interface SplitConfig {
  referrerBps: number;          // basis points (1000 = 10%)
  protocolBps: number;          // basis points (always 150 = 1.5%)
  splitConfigPda?: string;      // derived after on-chain init; vault = ATA(splitConfigPda, mint)
  protocolWallet?: string;      // Chest treasury pubkey
  merchantTokenAccount?: string;  // merchant USDC ATA
  protocolTokenAccount?: string;  // protocol USDC ATA
  /** When true, X-Referrer-Wallet is accepted without a signature. Default: false. */
  allowUnsignedReferrers?: boolean;
}

export interface ChestConfig {
  name: string;
  upstream: string;
  wallet: string;
  network: string;
  port: number;
  freebie: number;
  defaultPrice: number;
  /** Session duration in seconds, paying agent gets free reuse for this long. */
  session: number;
  routes: RouteConfig[];
  endpoints: EndpointConfig[];
  split?: SplitConfig;
}

interface GateOptions {
  price?: string;
  /** Either form is accepted, commander camelCases --payout-wallet to payoutWallet. */
  wallet?: string;
  payoutWallet?: string;
  wrap?: string;
  port?: string;
  freebie?: string;
  network?: string;
  session?: string;
  config?: string;
}

export async function loadConfig(opts: GateOptions): Promise<ChestConfig> {
  const configPath = opts.config || "chest.config.yaml";

  // Try loading from config file
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    const yaml = parseYaml(raw);

    // CLI flag (--payout-wallet) wins over YAML. The YAML field is `payoutWallet`.
    if (yaml.wallet !== undefined) {
      throw new Error(
        `${configPath}: \`wallet:\` is not a valid field. Rename it to \`payoutWallet:\`.`
      );
    }

    const payoutFlag = opts.payoutWallet ?? opts.wallet;

    return {
      name: yaml.name || "Chest Gate",
      upstream: normalizeUpstream(opts.wrap || yaml.upstream || ""),
      wallet: payoutFlag || yaml.payoutWallet || "",
      network: normalizeNetwork(opts.network || yaml.network || "devnet"),
      port: parseInt(opts.port || String(yaml.port || 4020), 10),
      freebie: parseInt(opts.freebie ?? String(yaml.freebie ?? 0), 10),
      defaultPrice: parsePrice(opts.price || yaml.price || "$0.01"),
      session: parseSession(opts.session ?? yaml.session),
      routes: parseRoutes(yaml.routes),
      endpoints: parseEndpoints(yaml.endpoints),
      split: parseSplit(yaml.split),
    };
  }

  // Fall back to CLI flags only
  return {
    name: "Chest Gate",
    upstream: normalizeUpstream(opts.wrap || ""),
    wallet: opts.payoutWallet ?? opts.wallet ?? "",
    network: normalizeNetwork(opts.network || "devnet"),
    port: parseInt(opts.port ?? "4020", 10),
    freebie: parseInt(opts.freebie ?? "0", 10),
    defaultPrice: parsePrice(opts.price || "$0.01"),
    session: parseSession(opts.session),
    routes: [],
    endpoints: [],
    split: undefined,
  };
}

/**
 * Accepts numbers, numeric strings, or suffixed strings ("5m", "1h", "30s").
 * Returns seconds. Defaults to 300 (5 min) when input is missing/invalid.
 */
function parseSession(input: unknown): number {
  if (input === undefined || input === null || input === "") return 300;
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.round(input) : 300;
  const s = String(input).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!match) return 300;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n < 0) return 300;
  const unit = match[2] ?? "s";
  if (unit.startsWith("h")) return Math.round(n * 3600);
  if (unit.startsWith("m") && unit !== "ms") return Math.round(n * 60);
  return Math.round(n);
}

function parseRoutes(routes: unknown): RouteConfig[] {
  if (!Array.isArray(routes)) return [];

  return routes.map((r: any) => ({
    path: String(r.path || r.route || ""),
    price: parsePrice(String(r.price || "$0.01")),
  }));
}

function parseEndpoints(endpoints: unknown): EndpointConfig[] {
  if (!Array.isArray(endpoints)) return [];

  const out: EndpointConfig[] = [];
  for (const e of endpoints) {
    if (!e || typeof e !== "object") continue;
    const path = String((e as any).path || (e as any).route || "").trim();
    if (!path) continue;
    const description = (e as any).description;
    const row: EndpointConfig = { path };
    if (typeof description === "string" && description.trim().length > 0) {
      row.description = description.trim();
    }
    out.push(row);
  }
  return out;
}

function parseSplit(split: unknown): SplitConfig | undefined {
  if (!split || typeof split !== 'object') return undefined;
  const s = split as Record<string, unknown>;
  const referrerPercent = parseFloat(String(s.referrer ?? 10));
  const protocolPercent = parseFloat(String(s.protocol ?? 1.5));
  return {
    referrerBps: Math.round(referrerPercent * 100),
    protocolBps: Math.round(protocolPercent * 100),
    splitConfigPda: s.splitConfigPda ? String(s.splitConfigPda) : undefined,
    protocolWallet: s.protocolWallet ? String(s.protocolWallet) : undefined,
    merchantTokenAccount: s.merchantTokenAccount ? String(s.merchantTokenAccount) : undefined,
    protocolTokenAccount: s.protocolTokenAccount ? String(s.protocolTokenAccount) : undefined,
    allowUnsignedReferrers: s.allowUnsignedReferrers === true || s.allowUnsignedReferrers === "true",
  };
}

export function normalizeNetwork(network: string): string {
  const n = network.toLowerCase().trim();
  if (n === "devnet" || n === "dev") return "solana-devnet";
  if (n === "mainnet" || n === "main" || n === "mainnet-beta") return "solana-mainnet";
  if (n.startsWith("solana:") || n.startsWith("solana-")) return n;
  return "solana-devnet";
}

function parsePrice(price: string): number {
  const cleaned = String(price).replace(/^\$/, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) return 0.01;
  return parsed;
}

function normalizeUpstream(url: string): string {
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return `http://${url}`;
  }
  return url;
}
