import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const CHEST_DIR = join(homedir(), ".chest");
const DB_PATH = join(CHEST_DIR, "transactions.db");

export class TransactionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || DB_PATH;
    const dir = join(path, "..");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_signature TEXT,
        payer_wallet TEXT NOT NULL,
        route TEXT NOT NULL,
        amount_usdc REAL NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING',
        client_ip TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        settled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_state ON transactions(state);
      CREATE INDEX IF NOT EXISTS idx_transactions_payer ON transactions(payer_wallet);
      CREATE INDEX IF NOT EXISTS idx_transactions_route ON transactions(route);
    `);

    const alterStatements = [
      "ALTER TABLE transactions ADD COLUMN merchant_amount REAL",
      "ALTER TABLE transactions ADD COLUMN referrer_amount REAL",
      "ALTER TABLE transactions ADD COLUMN protocol_amount REAL",
      "ALTER TABLE transactions ADD COLUMN referrer_wallet TEXT",
      "ALTER TABLE transactions ADD COLUMN distribute_tx TEXT",
      "ALTER TABLE transactions ADD COLUMN distribute_state TEXT",
    ];
    for (const sql of alterStatements) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  recordPending(payerWallet: string, route: string, amountUsdc: number, clientIp?: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO transactions (payer_wallet, route, amount_usdc, state, client_ip)
      VALUES (?, ?, ?, 'PENDING', ?)
    `);
    const result = stmt.run(payerWallet, route, amountUsdc, clientIp || "unknown");
    return Number(result.lastInsertRowid);
  }

  markSettled(id: number, txSignature: string): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET state = 'SETTLED', tx_signature = ?, settled_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(txSignature, id);
  }

  markFailed(id: number, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET state = 'FAILED', tx_signature = ?
      WHERE id = ?
    `);
    stmt.run(reason, id);
  }

  markDistributePending(id: number, referrerWallet: string | null, merchantAmount: number, referrerAmount: number, protocolAmount: number): void {
    this.db.prepare(`
      UPDATE transactions
      SET distribute_state = 'PENDING', referrer_wallet = ?, merchant_amount = ?, referrer_amount = ?, protocol_amount = ?
      WHERE id = ?
    `).run(referrerWallet, merchantAmount, referrerAmount, protocolAmount, id);
  }

  markDistributed(id: number, distributeTx: string): void {
    this.db.prepare(`
      UPDATE transactions
      SET distribute_state = 'DISTRIBUTED', distribute_tx = ?
      WHERE id = ?
    `).run(distributeTx, id);
  }

  markDistributeFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE transactions
      SET distribute_state = 'FAILED', distribute_tx = ?
      WHERE id = ?
    `).run(error, id);
  }

  getStats(): {
    totalTransactions: number;
    settledTransactions: number;
    totalRevenue: number;
    merchantRevenue: number;
    referrerRevenue: number;
    protocolRevenue: number;
    uniquePayers: number;
    uniqueReferrers: number;
    topRoutes: Array<{ route: string; count: number; revenue: number }>;
    topReferrers: Array<{ referrer: string; count: number; earned: number }>;
    recentTransactions: Array<{
      id: number;
      payerWallet: string;
      route: string;
      amountUsdc: number;
      merchantAmount: number | null;
      referrerAmount: number | null;
      protocolAmount: number | null;
      referrerWallet: string | null;
      state: string;
      distributeState: string | null;
      createdAt: string;
      txSignature: string | null;
    }>;
  } {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM transactions")
      .get() as { count: number };

    const settled = this.db
      .prepare("SELECT COUNT(*) as count FROM transactions WHERE state = 'SETTLED'")
      .get() as { count: number };

    const revenue = this.db
      .prepare("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM transactions WHERE state = 'SETTLED'")
      .get() as { total: number };

    const splits = this.db
      .prepare(`
        SELECT
          COALESCE(SUM(merchant_amount), 0) as merchant,
          COALESCE(SUM(referrer_amount), 0) as referrer,
          COALESCE(SUM(protocol_amount), 0) as protocol
        FROM transactions WHERE state = 'SETTLED'
      `)
      .get() as { merchant: number; referrer: number; protocol: number };

    const payers = this.db
      .prepare("SELECT COUNT(DISTINCT payer_wallet) as count FROM transactions WHERE state = 'SETTLED'")
      .get() as { count: number };

    const referrers = this.db
      .prepare("SELECT COUNT(DISTINCT referrer_wallet) as count FROM transactions WHERE referrer_wallet IS NOT NULL")
      .get() as { count: number };

    const topRoutes = this.db
      .prepare(`
        SELECT route, COUNT(*) as count, SUM(amount_usdc) as revenue
        FROM transactions WHERE state = 'SETTLED'
        GROUP BY route ORDER BY revenue DESC LIMIT 10
      `)
      .all() as Array<{ route: string; count: number; revenue: number }>;

    const topReferrers = this.db
      .prepare(`
        SELECT referrer_wallet as referrer, COUNT(*) as count, COALESCE(SUM(referrer_amount), 0) as earned
        FROM transactions WHERE referrer_wallet IS NOT NULL AND state = 'SETTLED'
        GROUP BY referrer_wallet ORDER BY earned DESC LIMIT 10
      `)
      .all() as Array<{ referrer: string; count: number; earned: number }>;

    const recentTransactions = this.db
      .prepare(`
        SELECT
          id, payer_wallet as payerWallet, route, amount_usdc as amountUsdc,
          merchant_amount as merchantAmount, referrer_amount as referrerAmount,
          protocol_amount as protocolAmount, referrer_wallet as referrerWallet,
          state, distribute_state as distributeState, created_at as createdAt,
          tx_signature as txSignature
        FROM transactions
        ORDER BY id DESC LIMIT 20
      `)
      .all() as any[];

    return {
      totalTransactions: total.count,
      settledTransactions: settled.count,
      totalRevenue: revenue.total,
      merchantRevenue: splits.merchant,
      referrerRevenue: splits.referrer,
      protocolRevenue: splits.protocol,
      uniquePayers: payers.count,
      uniqueReferrers: referrers.count,
      topRoutes,
      topReferrers,
      recentTransactions,
    };
  }

  close(): void {
    this.db.close();
  }
}
