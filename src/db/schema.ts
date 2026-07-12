import Database from "better-sqlite3";
import { nanoid } from "nanoid";

export function getDb(path: string): Database.Database {
  return new Database(path);
}

export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      source TEXT,
      amount REAL,
      merchant_raw TEXT,
      merchant_clean TEXT,
      category TEXT,
      datetime TEXT,
      card_last4 TEXT,
      is_committed INTEGER DEFAULT 0,
      is_credit_card_payment INTEGER DEFAULT 0,
      is_cancelled_out INTEGER DEFAULT 0,
      split_id TEXT,
      envelope_impact REAL,
      correlated_with TEXT,
      correlation_status TEXT DEFAULT 'none',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS splits (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      total_amount REAL,
      your_share REAL,
      paid_by_you INTEGER DEFAULT 1,
      people TEXT,
      settled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS committed_expenses (
      id TEXT PRIMARY KEY,
      label TEXT,
      merchant_pattern TEXT,
      vpa TEXT,
      amount_approx REAL,
      is_recurring INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS envelope (
      id INTEGER PRIMARY KEY DEFAULT 1,
      month TEXT,
      salary_day INTEGER,
      monthly_spendable REAL,
      committed_total REAL,
      discretionary_pool REAL,
      spent_discretionary REAL DEFAULT 0,
      current_week_start TEXT,
      current_week_budget REAL,
      current_week_spent REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS context (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT,
      content TEXT,
      interface TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_datetime ON transactions (datetime);
    CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions (source);
    CREATE INDEX IF NOT EXISTS idx_splits_transaction_id ON splits (transaction_id);
  `);

  seedEnvelope(db);
}

function seedEnvelope(db: Database.Database): void {
  const existing = db.prepare("SELECT id FROM envelope WHERE id = 1").get();
  if (existing) return;

  db.prepare(
    `INSERT INTO envelope (
      id, month, salary_day, monthly_spendable, committed_total,
      discretionary_pool, spent_discretionary, current_week_start,
      current_week_budget, current_week_spent
    ) VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, 0)`
  ).run(
    new Date().toISOString().slice(0, 7),
    1,
    0,
    0,
    0,
    new Date().toISOString().slice(0, 10),
    0
  );
}

export function newId(): string {
  return nanoid();
}
