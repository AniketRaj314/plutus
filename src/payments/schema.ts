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
    CREATE TABLE IF NOT EXISTS payment_request_qr (
      request_id TEXT PRIMARY KEY REFERENCES payment_requests(id), fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('waiting','queued','sending','sent','failed','uncertain','stale','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_until TEXT,
      telegram_message_id INTEGER, sent_at TEXT, last_error_code TEXT
    );
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
    CREATE TABLE IF NOT EXISTS bill_owner_messages (
      bill_id TEXT NOT NULL, message_id INTEGER NOT NULL REFERENCES agent_messages(id),
      PRIMARY KEY(bill_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS bill_explanations (
      bill_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id),
      explanation TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('confirmed','tentative','private')),
      revision TEXT NOT NULL, source_message_ids TEXT NOT NULL, updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(bill_id,contact_id)
    );
    CREATE TABLE IF NOT EXISTS payment_chat_sessions (
      contact_id TEXT PRIMARY KEY REFERENCES contacts(id), request_id TEXT REFERENCES payment_requests(id),
      selection_ids TEXT, pending_text TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_chat_events (
      id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id),
      request_id TEXT NOT NULL REFERENCES payment_requests(id),
      telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      text TEXT NOT NULL, response TEXT, intent TEXT,
      status TEXT NOT NULL DEFAULT 'pending', review_status TEXT NOT NULL DEFAULT 'none',
      attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_attempt_at TEXT,
      created_at TEXT NOT NULL, UNIQUE(telegram_user_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS payment_chat_outbox (
      id TEXT PRIMARY KEY, event_id INTEGER REFERENCES payment_chat_events(id),
      request_id TEXT NOT NULL REFERENCES payment_requests(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
      kind TEXT NOT NULL CHECK(kind IN ('owner_alert','recipient_reply','owner_relay')),
      dedupe_key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, chat_id TEXT NOT NULL,
      thread_id INTEGER, reply_to_message_id INTEGER, status TEXT NOT NULL DEFAULT 'queued',
      connection_user_id TEXT, contact_version INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_until TEXT,
      telegram_message_id INTEGER, last_error_code TEXT, created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_chat_outbox ON payment_chat_outbox(status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_payment_chat_events ON payment_chat_events(status,id);
  `);
}
