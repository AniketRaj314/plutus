import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Contact {
  id: string;
  display_name: string;
  kind: "unknown" | "person";
  version: number;
}

export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function findContact(
  db: Database.Database,
  nameOrId: string,
): Contact | undefined {
  return db
    .prepare(
      `SELECT c.* FROM contacts c WHERE c.id = ? OR c.id IN
    (SELECT contact_id FROM contact_aliases WHERE alias_key = ?)`,
    )
    .get(nameOrId, nameKey(nameOrId)) as Contact | undefined;
}

export function ensureContact(db: Database.Database, name: string): Contact {
  const existing = findContact(db, name);
  if (existing) return existing;
  const display = name.trim().replace(/\s+/g, " ");
  if (!display || display.length > 120)
    throw new Error("Contact name must be 1-120 characters");
  return db.transaction(() => {
    const id = randomUUID();
    db.prepare("INSERT INTO contacts (id, display_name) VALUES (?, ?)").run(
      id,
      display,
    );
    db.prepare(
      "INSERT INTO contact_aliases (alias_key, contact_id) VALUES (?, ?)",
    ).run(nameKey(display), id);
    return findContact(db, id)!;
  })();
}

// Resolve legacy name evidence through the same identity registry as new writes.
// Alias changes never rewrite bank evidence, person facts, or checkpoint source IDs.
export function counterpartyKey(db: Database.Database, name: string): string {
  return findContact(db, name)?.id ?? nameKey(name);
}

export function updateContact(
  db: Database.Database,
  id: string,
  input: {
    display_name?: string;
    alias?: string;
  },
): Contact {
  const contact = findContact(db, id);
  if (!contact) throw new Error("Contact not found");
  return db.transaction(() => {
    for (const value of [input.alias, input.display_name]) {
      if (value === undefined) continue;
      if (!nameKey(value) || value.length > 120)
        throw new Error("Invalid contact name");
      const other = findContact(db, value);
      if (other && other.id !== contact.id)
        throw new Error(
          "Alias already belongs to another contact; review identities first",
        );
      // Do not attach an existing unregistered ledger name without explicit identity review.
      db.prepare(
        "INSERT OR IGNORE INTO contact_aliases (alias_key, contact_id) VALUES (?, ?)",
      ).run(nameKey(value), contact.id);
    }
    db.prepare(
      "UPDATE contacts SET display_name = ?, version = version + 1 WHERE id = ?",
    ).run(
      input.display_name?.trim().replace(/\s+/g, " ") ?? contact.display_name,
      contact.id,
    );
    return findContact(db, contact.id)!;
  })();
}

export function listContacts(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT c.*, t.role, t.status AS access_status, t.username,
    t.delivery_status, t.status = 'active' AND t.private_chat_id IS NOT NULL AS connected,
    i.expected_username AS invited_username, i.role AS invited_role, i.expires_at AS invite_expires_at
    FROM contacts c LEFT JOIN telegram_contributors t ON t.contact_id = c.id
    LEFT JOIN telegram_contributor_invites i ON i.contact_id = c.id AND i.status = 'pending' AND i.expires_at > ?
    ORDER BY c.display_name COLLATE NOCASE`,
    )
    .all(new Date().toISOString());
}

function addColumn(
  db: Database.Database,
  table: string,
  name: string,
  type: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

export function migrateContacts(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'unknown' CHECK(kind IN ('unknown','person')),
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS contact_aliases (
        alias_key TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id)
      );
      CREATE TABLE IF NOT EXISTS contact_audit (
        id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id),
        action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    addColumn(db, "receivables", "contact_id", "TEXT REFERENCES contacts(id)");
    addColumn(
      db,
      "telegram_contributors",
      "contact_id",
      "TEXT REFERENCES contacts(id)",
    );
    addColumn(
      db,
      "telegram_contributors",
      "role",
      "TEXT NOT NULL DEFAULT 'contributor' CHECK(role IN ('recipient','contributor'))",
    );
    addColumn(db, "telegram_contributors", "private_chat_id", "TEXT");
    addColumn(db, "telegram_contributors", "username", "TEXT");
    addColumn(
      db,
      "telegram_contributors",
      "delivery_status",
      "TEXT NOT NULL DEFAULT 'ready' CHECK(delivery_status IN ('ready','opted_out','blocked'))",
    );
    addColumn(
      db,
      "telegram_contributor_invites",
      "contact_id",
      "TEXT REFERENCES contacts(id)",
    );
    addColumn(
      db,
      "telegram_contributor_invites",
      "role",
      "TEXT NOT NULL DEFAULT 'contributor' CHECK(role IN ('recipient','contributor'))",
    );
    addColumn(db, "telegram_contributor_invites", "expected_username", "TEXT");

    const names = db
      .prepare(
        `SELECT counterparty AS name FROM receivables UNION
      SELECT scope_id FROM context_facts WHERE scope_type = 'person' UNION
      SELECT counterparty_name FROM telegram_contributors UNION
      SELECT contributor_name FROM telegram_contributor_invites`,
      )
      .all() as Array<{ name: string }>;
    for (const { name } of names) if (name?.trim()) ensureContact(db, name);
    const transferFacts = db
      .prepare(
        "SELECT f.value,r.merchant_raw FROM context_facts f LEFT JOIN raw_transactions r ON f.scope_type='transaction' AND f.scope_id=r.id WHERE f.key IN ('counterparty_transfer','credit_allocation')",
      )
      .all() as Array<{ value: string; merchant_raw: string | null }>;
    for (const { value, merchant_raw } of transferFacts) {
      try {
        const name = JSON.parse(value).counterparty ?? merchant_raw;
        if (typeof name === "string" && name.trim()) ensureContact(db, name);
      } catch {
        /* Non-JSON historical context remains untouched. */
      }
    }
    for (const [table, column] of [
      ["receivables", "counterparty"],
      ["telegram_contributors", "counterparty_name"],
      ["telegram_contributor_invites", "contributor_name"],
    ]) {
      const rows = db
        .prepare(
          `SELECT rowid AS row_id, ${column} AS name FROM ${table} WHERE contact_id IS NULL`,
        )
        .all() as Array<{ row_id: number; name: string }>;
      for (const row of rows)
        db.prepare(`UPDATE ${table} SET contact_id = ? WHERE rowid = ?`).run(
          ensureContact(db, row.name).id,
          row.row_id,
        );
    }
    // A Telegram user's private chat ID is their user ID. Existing verified
    // contributors keep access, including those originally invited from a group.
    db.exec(`UPDATE telegram_contributors SET private_chat_id = telegram_user_id WHERE private_chat_id IS NULL;
      UPDATE contacts SET kind = 'person' WHERE id IN (SELECT contact_id FROM telegram_contributors);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_telegram ON telegram_contributors(contact_id);
      CREATE INDEX IF NOT EXISTS idx_receivable_contact ON receivables(contact_id);`);
  })();
}
