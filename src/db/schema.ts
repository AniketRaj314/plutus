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
      raw_email_id TEXT,
      is_reversal INTEGER DEFAULT 0,
      enrichment_confidence REAL,
      envelope_applied INTEGER DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      amount_inr REAL,
      is_international INTEGER DEFAULT 0,
      is_preauth INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS credit_cards (
      id TEXT PRIMARY KEY,
      name TEXT,
      last4 TEXT,
      billing_start_day INTEGER,
      billing_end_day INTEGER,
      due_day INTEGER,
      source TEXT
    );

    -- v2 financial ledger. The legacy transactions/envelope tables remain in
    -- place during migration, but the tables below deliberately separate raw
    -- bank evidence from AI/user-authored financial interpretations.
    CREATE TABLE IF NOT EXISTS salary_profiles (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      salary_day INTEGER NOT NULL CHECK (salary_day BETWEEN 1 AND 31),
      monthly_limit_inr REAL NOT NULL CHECK (monthly_limit_inr >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raw_transactions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      amount_inr REAL,
      merchant_raw TEXT,
      occurred_at TEXT NOT NULL,
      card_last4 TEXT,
      is_reversal INTEGER NOT NULL DEFAULT 0,
      is_international INTEGER NOT NULL DEFAULT 0,
      is_preauth INTEGER NOT NULL DEFAULT 0,
      raw_email_id TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS envelope_entries (
      id TEXT PRIMARY KEY,
      raw_transaction_id TEXT,
      funding_month TEXT NOT NULL,
      occurred_at TEXT,
      source TEXT,
      card_cycle_start TEXT,
      card_cycle_end TEXT,
      due_date TEXT,
      merchant_clean TEXT,
      category TEXT,
      treatment TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'actual'
        CHECK (state IN ('forecast', 'actual', 'settled', 'cancelled')),
      gross_amount_inr REAL NOT NULL DEFAULT 0,
      personal_impact REAL NOT NULL DEFAULT 0,
      cashflow_impact REAL NOT NULL DEFAULT 0,
      receivable_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      created_by TEXT NOT NULL,
      supersedes_id TEXT,
      superseded_at TEXT,
      replaced_by_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raw_transaction_id) REFERENCES raw_transactions(id),
      FOREIGN KEY (supersedes_id) REFERENCES envelope_entries(id),
      FOREIGN KEY (replaced_by_id) REFERENCES envelope_entries(id)
    );

    CREATE TABLE IF NOT EXISTS context_facts (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL
        CHECK (scope_type IN ('global', 'merchant', 'transaction', 'card', 'person')),
      scope_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      supersedes_id TEXT,
      superseded_at TEXT,
      replaced_by_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supersedes_id) REFERENCES context_facts(id),
      FOREIGN KEY (replaced_by_id) REFERENCES context_facts(id)
    );

    CREATE TABLE IF NOT EXISTS receivables (
      id TEXT PRIMARY KEY,
      envelope_entry_id TEXT,
      counterparty TEXT NOT NULL,
      label TEXT NOT NULL,
      amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
      received_inr REAL NOT NULL DEFAULT 0 CHECK (received_inr >= 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'partial', 'received', 'written_off')),
      expected_at TEXT,
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (envelope_entry_id) REFERENCES envelope_entries(id)
    );

    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
      frequency TEXT NOT NULL DEFAULT 'monthly',
      start_funding_month TEXT NOT NULL,
      end_funding_month TEXT,
      remaining_occurrences INTEGER CHECK (remaining_occurrences IS NULL OR remaining_occurrences >= 0),
      merchant_pattern TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
      notes TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_datetime ON transactions (datetime);
    CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions (source);
    CREATE INDEX IF NOT EXISTS idx_splits_transaction_id ON splits (transaction_id);
    CREATE INDEX IF NOT EXISTS idx_envelope_entries_funding_month ON envelope_entries (funding_month);
    CREATE INDEX IF NOT EXISTS idx_envelope_entries_source ON envelope_entries (source);
    CREATE INDEX IF NOT EXISTS idx_envelope_entries_raw_transaction ON envelope_entries (raw_transaction_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_envelope_entries_active_raw
      ON envelope_entries (raw_transaction_id)
      WHERE raw_transaction_id IS NOT NULL AND superseded_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_context_facts_active_scope_key
      ON context_facts (scope_type, scope_id, key)
      WHERE superseded_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_receivables_status ON receivables (status);
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments (status);
    CREATE INDEX IF NOT EXISTS idx_raw_transactions_occurred_at ON raw_transactions (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_raw_transactions_source ON raw_transactions (source);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_transactions_email
      ON raw_transactions (raw_email_id) WHERE raw_email_id IS NOT NULL;
  `);

  ensureColumn(db, "transactions", "raw_email_id", "TEXT");
  ensureColumn(db, "transactions", "is_reversal", "INTEGER DEFAULT 0");
  ensureColumn(db, "transactions", "enrichment_confidence", "REAL");
  ensureColumn(db, "transactions", "envelope_applied", "INTEGER DEFAULT 0");
  ensureColumn(db, "transactions", "currency", "TEXT DEFAULT 'INR'");
  ensureColumn(db, "transactions", "amount_inr", "REAL");
  ensureColumn(db, "transactions", "is_international", "INTEGER DEFAULT 0");
  ensureColumn(db, "transactions", "is_preauth", "INTEGER DEFAULT 0");
  ensureColumn(db, "raw_transactions", "is_preauth", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_raw_email_id ON transactions (raw_email_id);`);

  seedEnvelope(db);
  seedCreditCards(db);
  seedSalaryProfile(db);
  backfillRawTransactions(db);
  backfillContextFacts(db);
  seedCanonicalContextFacts(db);
}

function seedCreditCards(db: Database.Database): void {
  const cards = [
    { id: "amex", name: "American Express", last4: "41001", billing_start_day: 21, billing_end_day: 20, due_day: 8, source: "amex" },
    { id: "bobcard", name: "BOBCARD One", last4: "8533", billing_start_day: 22, billing_end_day: 21, due_day: 9, source: "bobcard" },
    { id: "idfc_cc", name: "IDFC FIRST Credit Card", last4: "6198", billing_start_day: 20, billing_end_day: 19, due_day: 4, source: "idfc_cc" },
  ];

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO credit_cards (id, name, last4, billing_start_day, billing_end_day, due_day, source)
     VALUES (@id, @name, @last4, @billing_start_day, @billing_end_day, @due_day, @source)`
  );

  for (const card of cards) {
    stmt.run(card);
  }
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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

function seedSalaryProfile(db: Database.Database): void {
  const legacy = db
    .prepare("SELECT salary_day, monthly_spendable FROM envelope WHERE id = 1")
    .get() as { salary_day?: number; monthly_spendable?: number } | undefined;
  db.prepare(
    `INSERT OR IGNORE INTO salary_profiles (
      id, label, salary_day, monthly_limit_inr, currency, is_active
    ) VALUES ('default', 'Primary salary', ?, ?, 'INR', 1)`
  ).run(legacy?.salary_day ?? 1, legacy?.monthly_spendable || 120000);
}

function backfillRawTransactions(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO raw_transactions (
      id, source, amount, currency, amount_inr, merchant_raw, occurred_at,
      card_last4, is_reversal, is_international, is_preauth, raw_email_id
    )
    SELECT
      id, COALESCE(source, 'unknown'), COALESCE(amount, 0), COALESCE(currency, 'INR'),
      amount_inr, merchant_raw, COALESCE(datetime, created_at), card_last4,
      COALESCE(is_reversal, 0), COALESCE(is_international, 0), COALESCE(is_preauth, 0), raw_email_id
    FROM transactions`
  ).run();
}

function backfillContextFacts(db: Database.Database): void {
  const internalKeys = new Set(["telegram_message_map", "processed_message_ids", "last_gmail_poll"]);
  const legacy = db.prepare("SELECT key, value FROM context WHERE value IS NOT NULL").all() as Array<{
    key: string;
    value: string;
  }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO context_facts (
      id, scope_type, scope_id, key, value, source, confidence
    ) VALUES (?, 'global', '', ?, ?, 'legacy_migration', 1)`
  );
  for (const row of legacy) {
    if (internalKeys.has(row.key)) continue;
    insert.run(newId(), row.key, row.value);
  }
}

function seedCanonicalContextFacts(db: Database.Database): void {
  const monthlySpendingDefinition = JSON.stringify({
    definition_version: 1,
    metric: "monthly_spending_envelope",
    card_rule: "include active entries whose card_cycle_end month equals the requested spend month",
    idfc_upi_rule: "include active entries whose occurred_at month in Asia/Kolkata equals the requested spend month",
    impact_field: "personal_impact",
    monthly_limit_source: "active salary profile",
    excludes_via_zero_impact: ["settlement", "bookkeeping", "pass-through"],
    canonical_mcp_tool: "get_spend_month_summary",
  });
  db.prepare(
    `INSERT OR IGNORE INTO context_facts (
      id, scope_type, scope_id, key, value, source, confidence
    ) VALUES (
      'system_monthly_spending_definition_v1', 'global', '',
      'monthly_spending_envelope_definition', ?, 'system', 1
    )`
  ).run(monthlySpendingDefinition);
}

export function newId(): string {
  return nanoid();
}
