import type Database from "better-sqlite3";

export function migratePaymentRequests(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_batches (
      id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES payment_batches(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      dedupe_key TEXT NOT NULL UNIQUE, basis TEXT NOT NULL CHECK(basis IN ('split','net_balance')),
      source_ids TEXT NOT NULL, context TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','queued','sending','sent','failed','uncertain','stale','cancelled')),
      authorized_by TEXT, authorized_at TEXT, expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT,
      telegram_message_id INTEGER, sent_at TEXT, last_error_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_queue ON payment_requests(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS payment_batch_items (
      batch_id TEXT NOT NULL REFERENCES payment_batches(id),
      request_id TEXT NOT NULL REFERENCES payment_requests(id), PRIMARY KEY(batch_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS payment_attempts (
      id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES payment_requests(id),
      attempt INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      outcome TEXT, error_code TEXT, telegram_message_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS payment_replies (
      id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES payment_requests(id),
      telegram_user_id TEXT NOT NULL, message_id INTEGER NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(telegram_user_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS payment_audit (
      id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES payment_requests(id),
      action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}
