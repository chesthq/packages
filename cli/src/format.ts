import chalk from "chalk";

interface PrintOptions {
  /** Wrap value strings longer than this with an ellipsis. 0 disables. */
  truncate?: number;
  /** Minimum gap between key and value, in spaces. Default 2. */
  gap?: number;
}

/**
 * Render a flat key/value record with the value column aligned to the
 * widest key + a fixed gap. Skips null/undefined entries. Objects/arrays
 * are JSON-stringified.
 */
export function printKeyValues(record: Record<string, unknown>, opts: PrintOptions = {}): void {
  const truncate = opts.truncate ?? 0;
  const gap = opts.gap ?? 2;

  const entries = Object.entries(record).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return;

  const keyWidth = Math.max(...entries.map(([k]) => k.length)) + gap;

  for (const [k, v] of entries) {
    const raw = typeof v === "object" ? JSON.stringify(v) : String(v);
    const value = truncate > 0 && raw.length > truncate ? raw.slice(0, truncate) + "…" : raw;
    console.log(chalk.gray("  " + k.padEnd(keyWidth)) + chalk.white(value));
  }
}
