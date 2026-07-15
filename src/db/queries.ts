import type Database from "better-sqlite3";
import { newId } from "./schema";

export interface Transaction {
  id: string;
  source: string | null;
  amount: number | null;
  merchant_raw: string | null;
  merchant_clean: string | null;
  category: string | null;
  datetime: string | null;
  card_last4: string | null;
  is_committed: number;
  is_credit_card_payment: number;
  is_cancelled_out: number;
  split_id: string | null;
  envelope_impact: number | null;
  correlated_with: string | null;
  correlation_status: string;
  notes: string | null;
  raw_email_id: string | null;
  is_reversal: number;
  enrichment_confidence: number | null;
  envelope_applied: number;
  currency: string;
  amount_inr: number | null;
  is_international: number;
  is_preauth: number;
  direction: "debit" | "credit";
  created_at: string;
}

export type NewTransaction = Partial<Omit<Transaction, "id" | "created_at">>;

export interface Split {
  id: string;
  transaction_id: string | null;
  total_amount: number | null;
  your_share: number | null;
  paid_by_you: number;
  people: string | null;
  settled: number;
  created_at: string;
}

export type NewSplit = Partial<Omit<Split, "id" | "created_at">>;

export interface CommittedExpense {
  id: string;
  label: string | null;
  merchant_pattern: string | null;
  vpa: string | null;
  amount_approx: number | null;
  is_recurring: number;
  created_at: string;
}

export type NewCommittedExpense = Partial<Omit<CommittedExpense, "id" | "created_at">>;

export interface Envelope {
  id: number;
  month: string | null;
  salary_day: number | null;
  monthly_spendable: number | null;
  committed_total: number | null;
  discretionary_pool: number | null;
  spent_discretionary: number;
  current_week_start: string | null;
  current_week_budget: number | null;
  current_week_spent: number;
  updated_at: string;
}

export type EnvelopeUpdate = Partial<Omit<Envelope, "id" | "updated_at">>;

export interface ContextRow {
  key: string;
  value: string | null;
  updated_at: string;
}

export interface AgentMessage {
  id: number;
  role: string | null;
  content: string | null;
  interface: string | null;
  created_at: string;
}

export type NewAgentMessage = Partial<Omit<AgentMessage, "id" | "created_at">>;

export interface CreditCard {
  id: string;
  name: string | null;
  last4: string | null;
  billing_start_day: number | null;
  billing_end_day: number | null;
  due_day: number | null;
  source: string | null;
}

// -- transactions --

export function insertTransaction(db: Database.Database, data: NewTransaction): Transaction {
  const id = newId();
  db.prepare(
    `INSERT INTO transactions (
      id, source, amount, merchant_raw, merchant_clean, category, datetime,
      card_last4, is_committed, is_credit_card_payment, is_cancelled_out,
      split_id, envelope_impact, correlated_with, correlation_status, notes, raw_email_id, is_reversal,
      enrichment_confidence, envelope_applied, currency, amount_inr, is_international, is_preauth, direction
    ) VALUES (
      @id, @source, @amount, @merchant_raw, @merchant_clean, @category, @datetime,
      @card_last4, @is_committed, @is_credit_card_payment, @is_cancelled_out,
      @split_id, @envelope_impact, @correlated_with, @correlation_status, @notes, @raw_email_id, @is_reversal,
      @enrichment_confidence, @envelope_applied, @currency, @amount_inr, @is_international, @is_preauth, @direction
    )`
  ).run({
    id,
    source: data.source ?? null,
    amount: data.amount ?? null,
    merchant_raw: data.merchant_raw ?? null,
    merchant_clean: data.merchant_clean ?? null,
    category: data.category ?? null,
    datetime: data.datetime ?? null,
    card_last4: data.card_last4 ?? null,
    is_committed: data.is_committed ?? 0,
    is_credit_card_payment: data.is_credit_card_payment ?? 0,
    is_cancelled_out: data.is_cancelled_out ?? 0,
    split_id: data.split_id ?? null,
    envelope_impact: data.envelope_impact ?? null,
    correlated_with: data.correlated_with ?? null,
    correlation_status: data.correlation_status ?? "none",
    notes: data.notes ?? null,
    raw_email_id: data.raw_email_id ?? null,
    is_reversal: data.is_reversal ?? 0,
    enrichment_confidence: data.enrichment_confidence ?? null,
    envelope_applied: data.envelope_applied ?? 0,
    currency: data.currency ?? "INR",
    amount_inr: data.amount_inr ?? null,
    is_international: data.is_international ?? 0,
    is_preauth: data.is_preauth ?? 0,
    direction: data.direction ?? "debit",
  });
  return getTransaction(db, id) as Transaction;
}

export function getTransaction(db: Database.Database, id: string): Transaction | undefined {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as Transaction | undefined;
}

export function getTransactionByRawEmailId(
  db: Database.Database,
  rawEmailId: string
): Transaction | undefined {
  return db
    .prepare("SELECT * FROM transactions WHERE raw_email_id = ?")
    .get(rawEmailId) as Transaction | undefined;
}

export function findTransactionByContentKey(
  db: Database.Database,
  source: string,
  amount: number,
  merchantRaw: string | null,
  datetimeMinute: string
): Transaction | undefined {
  if (merchantRaw === null) {
    return db
      .prepare(
        `SELECT * FROM transactions
         WHERE source = ? AND amount = ? AND merchant_raw IS NULL AND substr(datetime, 1, 16) = ?`
      )
      .get(source, amount, datetimeMinute) as Transaction | undefined;
  }

  return db
    .prepare(
      `SELECT * FROM transactions
       WHERE source = ? AND amount = ? AND merchant_raw = ? AND substr(datetime, 1, 16) = ?`
    )
    .get(source, amount, merchantRaw, datetimeMinute) as Transaction | undefined;
}

export function listTransactions(db: Database.Database, limit = 50): Transaction[] {
  return db
    .prepare("SELECT * FROM transactions ORDER BY datetime DESC LIMIT ?")
    .all(limit) as Transaction[];
}

export interface TransactionFilters {
  since?: string;
  until?: string;
  source?: string;
  category?: string;
  min_amount?: number;
  limit?: number;
}

export function queryTransactions(db: Database.Database, filters: TransactionFilters): Transaction[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.since) {
    clauses.push("datetime >= @since");
    params.since = filters.since;
  }
  if (filters.until) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.until)) {
      const next = new Date(`${filters.until}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      clauses.push("datetime < @until_exclusive");
      params.until_exclusive = next.toISOString().slice(0, 10);
    } else {
      clauses.push("datetime <= @until");
      params.until = filters.until;
    }
  }
  if (filters.source) {
    clauses.push("source = @source");
    params.source = filters.source;
  }
  if (filters.category) {
    clauses.push("category = @category");
    params.category = filters.category;
  }
  if (filters.min_amount !== undefined) {
    clauses.push("amount >= @min_amount");
    params.min_amount = filters.min_amount;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.limit = filters.limit ?? 20;

  return db
    .prepare(`SELECT * FROM transactions ${where} ORDER BY datetime DESC LIMIT @limit`)
    .all(params) as Transaction[];
}

export function listPendingCorrelations(db: Database.Database): Transaction[] {
  return db
    .prepare("SELECT * FROM transactions WHERE correlation_status = 'pending' ORDER BY datetime ASC")
    .all() as Transaction[];
}

export function updateTransaction(
  db: Database.Database,
  id: string,
  data: Partial<NewTransaction>
): Transaction | undefined {
  const fields = Object.keys(data);
  if (fields.length === 0) return getTransaction(db, id);

  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE transactions SET ${setClause} WHERE id = @id`).run({
    ...data,
    id,
  });
  return getTransaction(db, id);
}

export function deleteTransaction(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
}

// -- splits --

export function insertSplit(db: Database.Database, data: NewSplit): Split {
  const id = newId();
  db.prepare(
    `INSERT INTO splits (id, transaction_id, total_amount, your_share, paid_by_you, people, settled)
     VALUES (@id, @transaction_id, @total_amount, @your_share, @paid_by_you, @people, @settled)`
  ).run({
    id,
    transaction_id: data.transaction_id ?? null,
    total_amount: data.total_amount ?? null,
    your_share: data.your_share ?? null,
    paid_by_you: data.paid_by_you ?? 1,
    people: data.people ?? null,
    settled: data.settled ?? 0,
  });
  return getSplit(db, id) as Split;
}

export function getSplit(db: Database.Database, id: string): Split | undefined {
  return db.prepare("SELECT * FROM splits WHERE id = ?").get(id) as Split | undefined;
}

export function listSplitsForTransaction(db: Database.Database, transactionId: string): Split[] {
  return db
    .prepare("SELECT * FROM splits WHERE transaction_id = ?")
    .all(transactionId) as Split[];
}

export function listAllSplits(db: Database.Database): Split[] {
  return db.prepare("SELECT * FROM splits ORDER BY created_at DESC").all() as Split[];
}

export function updateSplit(
  db: Database.Database,
  id: string,
  data: Partial<NewSplit>
): Split | undefined {
  const fields = Object.keys(data);
  if (fields.length === 0) return getSplit(db, id);

  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE splits SET ${setClause} WHERE id = @id`).run({ ...data, id });
  return getSplit(db, id);
}

export function deleteSplit(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM splits WHERE id = ?").run(id);
}

// -- committed_expenses --

export function insertCommittedExpense(
  db: Database.Database,
  data: NewCommittedExpense
): CommittedExpense {
  const id = newId();
  db.prepare(
    `INSERT INTO committed_expenses (id, label, merchant_pattern, vpa, amount_approx, is_recurring)
     VALUES (@id, @label, @merchant_pattern, @vpa, @amount_approx, @is_recurring)`
  ).run({
    id,
    label: data.label ?? null,
    merchant_pattern: data.merchant_pattern ?? null,
    vpa: data.vpa ?? null,
    amount_approx: data.amount_approx ?? null,
    is_recurring: data.is_recurring ?? 1,
  });
  return getCommittedExpense(db, id) as CommittedExpense;
}

export function getCommittedExpense(
  db: Database.Database,
  id: string
): CommittedExpense | undefined {
  return db
    .prepare("SELECT * FROM committed_expenses WHERE id = ?")
    .get(id) as CommittedExpense | undefined;
}

export function listCommittedExpenses(db: Database.Database): CommittedExpense[] {
  return db.prepare("SELECT * FROM committed_expenses ORDER BY label ASC").all() as CommittedExpense[];
}

export function deleteCommittedExpense(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM committed_expenses WHERE id = ?").run(id);
}

// -- credit_cards --

export function listCreditCards(db: Database.Database): CreditCard[] {
  return db.prepare("SELECT * FROM credit_cards ORDER BY id ASC").all() as CreditCard[];
}

export function getCreditCard(db: Database.Database, id: string): CreditCard | undefined {
  return db.prepare("SELECT * FROM credit_cards WHERE id = ?").get(id) as CreditCard | undefined;
}

// -- envelope (single row, id = 1) --

export function getEnvelope(db: Database.Database): Envelope | undefined {
  return db.prepare("SELECT * FROM envelope WHERE id = 1").get() as Envelope | undefined;
}

export function updateEnvelope(db: Database.Database, data: EnvelopeUpdate): Envelope | undefined {
  const fields = Object.keys(data);
  if (fields.length === 0) return getEnvelope(db);

  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(
    `UPDATE envelope SET ${setClause}, updated_at = datetime('now') WHERE id = 1`
  ).run(data);
  return getEnvelope(db);
}

// -- context (key/value store) --

export function getContext(db: Database.Database, key: string): ContextRow | undefined {
  return db.prepare("SELECT * FROM context WHERE key = ?").get(key) as ContextRow | undefined;
}

export function setContext(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO context (key, value, updated_at) VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')`
  ).run({ key, value });
}

export function listContext(db: Database.Database): ContextRow[] {
  return db.prepare("SELECT * FROM context ORDER BY key ASC").all() as ContextRow[];
}

export function deleteContext(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM context WHERE key = ?").run(key);
}

// -- agent_messages --

export function insertAgentMessage(db: Database.Database, data: NewAgentMessage): AgentMessage {
  const result = db
    .prepare(
      `INSERT INTO agent_messages (role, content, interface) VALUES (@role, @content, @interface)`
    )
    .run({
      role: data.role ?? null,
      content: data.content ?? null,
      interface: data.interface ?? null,
    });
  return db
    .prepare("SELECT * FROM agent_messages WHERE id = ?")
    .get(result.lastInsertRowid) as AgentMessage;
}

export function listRecentAgentMessages(db: Database.Database, limit = 50): AgentMessage[] {
  return db
    .prepare("SELECT * FROM agent_messages ORDER BY id DESC LIMIT ?")
    .all(limit) as AgentMessage[];
}
