import type Database from "better-sqlite3";
import { newId } from "./schema";
import { getSalaryFundingMonthForDate } from "../envelope/engine";

export type EnvelopeEntryState = "forecast" | "actual" | "settled" | "cancelled";
export type ContextScope = "global" | "merchant" | "transaction" | "card" | "person";
export type ReceivableStatus = "pending" | "partial" | "received" | "written_off";
export type CommitmentStatus = "active" | "paused" | "completed" | "cancelled";
export type TransactionDirection = "debit" | "credit";

export interface SalaryProfile {
  id: string;
  label: string;
  salary_day: number;
  monthly_limit_inr: number;
  currency: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface RawTransactionV2 {
  id: string;
  source: string;
  amount: number;
  currency: string;
  amount_inr: number | null;
  merchant_raw: string | null;
  occurred_at: string;
  card_last4: string | null;
  is_reversal: number;
  is_international: number;
  is_preauth: number;
  direction: TransactionDirection;
  raw_email_id: string | null;
  raw_payload: string | null;
  created_at: string;
}

export interface CreateRawTransactionInput {
  id?: string;
  source: string;
  amount: number;
  currency?: string;
  amount_inr?: number | null;
  merchant_raw?: string | null;
  occurred_at: string;
  card_last4?: string | null;
  is_reversal?: boolean;
  is_international?: boolean;
  is_preauth?: boolean;
  direction?: TransactionDirection;
  raw_email_id?: string | null;
  raw_payload?: string | null;
}

export interface EnvelopeEntry {
  id: string;
  raw_transaction_id: string | null;
  funding_month: string;
  occurred_at: string | null;
  source: string | null;
  card_cycle_start: string | null;
  card_cycle_end: string | null;
  due_date: string | null;
  merchant_clean: string | null;
  category: string | null;
  treatment: string;
  state: EnvelopeEntryState;
  gross_amount_inr: number;
  personal_impact: number;
  cashflow_impact: number;
  receivable_amount: number;
  notes: string | null;
  confidence: number | null;
  created_by: string;
  supersedes_id: string | null;
  superseded_at: string | null;
  replaced_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateEnvelopeEntryInput {
  raw_transaction_id?: string;
  funding_month: string;
  occurred_at?: string;
  source?: string;
  card_cycle_start?: string;
  card_cycle_end?: string;
  due_date?: string;
  merchant_clean?: string;
  category?: string;
  treatment: string;
  state?: EnvelopeEntryState;
  gross_amount_inr?: number;
  personal_impact?: number;
  cashflow_impact?: number;
  receivable_amount?: number;
  notes?: string;
  confidence?: number;
  created_by: string;
  supersedes_id?: string;
}

export interface EnvelopeEntryFilters {
  funding_month?: string;
  source?: string;
  state?: EnvelopeEntryState;
  treatment?: string;
  raw_transaction_id?: string;
  include_superseded?: boolean;
  limit?: number;
}

export interface ContextFact {
  id: string;
  scope_type: ContextScope;
  scope_id: string;
  key: string;
  value: string;
  source: string;
  confidence: number | null;
  supersedes_id: string | null;
  superseded_at: string | null;
  replaced_by_id: string | null;
  created_at: string;
}

export interface Receivable {
  id: string;
  envelope_entry_id: string | null;
  counterparty: string;
  label: string;
  amount_inr: number;
  received_inr: number;
  status: ReceivableStatus;
  expected_at: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreditAllocation {
  receivable_id?: string | null;
  kind: string;
  amount_inr: number;
  notes?: string | null;
}

export interface ConfirmCreditAllocationInput {
  raw_transaction_id: string;
  allocations: CreditAllocation[];
  treatment: string;
  personal_impact: number;
  cashflow_impact: number;
  category?: string;
  notes?: string;
  created_by: string;
}

export interface Commitment {
  id: string;
  label: string;
  amount_inr: number;
  frequency: string;
  start_funding_month: string;
  end_funding_month: string | null;
  remaining_occurrences: number | null;
  merchant_pattern: string | null;
  status: CommitmentStatus;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function assertFundingMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error(`funding_month must be YYYY-MM, received "${value}"`);
  }
}

function assertConfidence(value: number | undefined): void {
  if (value !== undefined && (value < 0 || value > 1)) {
    throw new Error("confidence must be between 0 and 1");
  }
}

function assertFiniteMoney(label: string, value: number | undefined): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

export function getRawTransaction(db: Database.Database, id: string): RawTransactionV2 | undefined {
  return db.prepare("SELECT * FROM raw_transactions WHERE id = ?").get(id) as RawTransactionV2 | undefined;
}

export function insertRawTransaction(db: Database.Database, input: CreateRawTransactionInput): RawTransactionV2 {
  if (!Number.isFinite(input.amount)) throw new Error("amount must be a finite number");
  if (!input.source) throw new Error("source is required");
  if (!input.occurred_at || Number.isNaN(new Date(input.occurred_at).getTime())) {
    throw new Error("occurred_at must be valid ISO 8601");
  }
  const id = input.id ?? newId();
  db.prepare(
    `INSERT OR IGNORE INTO raw_transactions (
      id, source, amount, currency, amount_inr, merchant_raw, occurred_at,
      card_last4, is_reversal, is_international, is_preauth, direction, raw_email_id, raw_payload
    ) VALUES (
      @id, @source, @amount, @currency, @amount_inr, @merchant_raw, @occurred_at,
      @card_last4, @is_reversal, @is_international, @is_preauth, @direction, @raw_email_id, @raw_payload
    )`
  ).run({
    id,
    source: input.source,
    amount: input.amount,
    currency: input.currency ?? "INR",
    amount_inr: input.amount_inr ?? null,
    merchant_raw: input.merchant_raw ?? null,
    occurred_at: input.occurred_at,
    card_last4: input.card_last4 ?? null,
    is_reversal: input.is_reversal ? 1 : 0,
    is_international: input.is_international ? 1 : 0,
    is_preauth: input.is_preauth ? 1 : 0,
    direction: input.direction ?? "debit",
    raw_email_id: input.raw_email_id ?? null,
    raw_payload: input.raw_payload ?? null,
  });

  const byId = getRawTransaction(db, id);
  if (byId) return byId;
  if (input.raw_email_id) {
    const existing = db
      .prepare("SELECT * FROM raw_transactions WHERE raw_email_id = ?")
      .get(input.raw_email_id) as RawTransactionV2 | undefined;
    if (existing) return existing;
  }
  throw new Error("raw transaction insert failed");
}

export function getActiveSalaryProfile(db: Database.Database): SalaryProfile | undefined {
  return db
    .prepare("SELECT * FROM salary_profiles WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1")
    .get() as SalaryProfile | undefined;
}

export function updateSalaryProfile(
  db: Database.Database,
  id: string,
  updates: { label?: string; salary_day?: number; monthly_limit_inr?: number; is_active?: boolean }
): SalaryProfile | undefined {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  if (updates.label !== undefined) {
    fields.push("label = @label");
    params.label = updates.label;
  }
  if (updates.salary_day !== undefined) {
    if (updates.salary_day < 1 || updates.salary_day > 31) throw new Error("salary_day must be between 1 and 31");
    fields.push("salary_day = @salary_day");
    params.salary_day = updates.salary_day;
  }
  if (updates.monthly_limit_inr !== undefined) {
    if (updates.monthly_limit_inr < 0) throw new Error("monthly_limit_inr must be non-negative");
    fields.push("monthly_limit_inr = @monthly_limit_inr");
    params.monthly_limit_inr = updates.monthly_limit_inr;
  }
  if (updates.is_active !== undefined) {
    fields.push("is_active = @is_active");
    params.is_active = updates.is_active ? 1 : 0;
  }
  if (fields.length === 0) {
    return db.prepare("SELECT * FROM salary_profiles WHERE id = ?").get(id) as SalaryProfile | undefined;
  }
  db.prepare(
    `UPDATE salary_profiles SET ${fields.join(", ")}, updated_at = datetime('now') WHERE id = @id`
  ).run(params);
  return db.prepare("SELECT * FROM salary_profiles WHERE id = ?").get(id) as SalaryProfile | undefined;
}

export function getEnvelopeEntry(db: Database.Database, id: string): EnvelopeEntry | undefined {
  return db.prepare("SELECT * FROM envelope_entries WHERE id = ?").get(id) as EnvelopeEntry | undefined;
}

export function createEnvelopeEntry(db: Database.Database, input: CreateEnvelopeEntryInput): EnvelopeEntry {
  assertFundingMonth(input.funding_month);
  assertConfidence(input.confidence);
  assertFiniteMoney("gross_amount_inr", input.gross_amount_inr);
  assertFiniteMoney("personal_impact", input.personal_impact);
  assertFiniteMoney("cashflow_impact", input.cashflow_impact);
  assertFiniteMoney("receivable_amount", input.receivable_amount);

  const operation = db.transaction(() => {
    const id = newId();
    let replaced: EnvelopeEntry | undefined;

    if (input.supersedes_id) {
      replaced = getEnvelopeEntry(db, input.supersedes_id);
      if (!replaced) throw new Error(`envelope entry ${input.supersedes_id} not found`);
      if (replaced.superseded_at) throw new Error(`envelope entry ${input.supersedes_id} is already superseded`);
      if (
        input.raw_transaction_id !== undefined &&
        replaced.raw_transaction_id !== null &&
        input.raw_transaction_id !== replaced.raw_transaction_id
      ) {
        throw new Error("a replacement must refer to the same raw transaction");
      }

      db.prepare(
        `UPDATE envelope_entries
         SET superseded_at = datetime('now'), updated_at = datetime('now')
         WHERE id = @id`
      ).run({ id: replaced.id });
    }

    const rawTransactionId = input.raw_transaction_id ?? replaced?.raw_transaction_id ?? null;
    db.prepare(
      `INSERT INTO envelope_entries (
        id, raw_transaction_id, funding_month, occurred_at, source,
        card_cycle_start, card_cycle_end, due_date, merchant_clean, category,
        treatment, state, gross_amount_inr, personal_impact, cashflow_impact,
        receivable_amount, notes, confidence, created_by, supersedes_id
      ) VALUES (
        @id, @raw_transaction_id, @funding_month, @occurred_at, @source,
        @card_cycle_start, @card_cycle_end, @due_date, @merchant_clean, @category,
        @treatment, @state, @gross_amount_inr, @personal_impact, @cashflow_impact,
        @receivable_amount, @notes, @confidence, @created_by, @supersedes_id
      )`
    ).run({
      id,
      raw_transaction_id: rawTransactionId,
      funding_month: input.funding_month,
      occurred_at: input.occurred_at ?? replaced?.occurred_at ?? null,
      source: input.source ?? replaced?.source ?? null,
      card_cycle_start: input.card_cycle_start ?? replaced?.card_cycle_start ?? null,
      card_cycle_end: input.card_cycle_end ?? replaced?.card_cycle_end ?? null,
      due_date: input.due_date ?? replaced?.due_date ?? null,
      merchant_clean: input.merchant_clean ?? replaced?.merchant_clean ?? null,
      category: input.category ?? replaced?.category ?? null,
      treatment: input.treatment,
      state: input.state ?? "actual",
      gross_amount_inr: input.gross_amount_inr ?? replaced?.gross_amount_inr ?? 0,
      personal_impact: input.personal_impact ?? 0,
      cashflow_impact: input.cashflow_impact ?? 0,
      receivable_amount: input.receivable_amount ?? 0,
      notes: input.notes ?? null,
      confidence: input.confidence ?? null,
      created_by: input.created_by,
      supersedes_id: input.supersedes_id ?? null,
    });

    if (replaced) {
      db.prepare("UPDATE envelope_entries SET replaced_by_id = ? WHERE id = ?").run(id, replaced.id);
      // A correction must not make money owed disappear merely because the
      // interpretation it was attached to became historical. Carry linked
      // receivables forward to the active replacement; an agent can still
      // explicitly mark them received or written off when the facts change.
      db.prepare(
        `UPDATE receivables
         SET envelope_entry_id = ?, updated_at = datetime('now')
         WHERE envelope_entry_id = ?`
      ).run(id, replaced.id);
    }

    return getEnvelopeEntry(db, id) as EnvelopeEntry;
  });

  return operation();
}

export function listEnvelopeEntries(db: Database.Database, filters: EnvelopeEntryFilters = {}): EnvelopeEntry[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: Math.min(Math.max(filters.limit ?? 200, 1), 1000) };
  if (!filters.include_superseded) clauses.push("superseded_at IS NULL");
  if (filters.funding_month) {
    assertFundingMonth(filters.funding_month);
    clauses.push("funding_month = @funding_month");
    params.funding_month = filters.funding_month;
  }
  if (filters.source) {
    clauses.push("source = @source");
    params.source = filters.source;
  }
  if (filters.state) {
    clauses.push("state = @state");
    params.state = filters.state;
  }
  if (filters.treatment) {
    clauses.push("treatment = @treatment");
    params.treatment = filters.treatment;
  }
  if (filters.raw_transaction_id) {
    clauses.push("raw_transaction_id = @raw_transaction_id");
    params.raw_transaction_id = filters.raw_transaction_id;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM envelope_entries ${where} ORDER BY funding_month DESC, occurred_at DESC, created_at DESC LIMIT @limit`)
    .all(params) as EnvelopeEntry[];
}

export type LedgerGroupBy = "source" | "category" | "treatment" | "state";

export interface SpendMonthSummary {
  spend_month: string;
  definition_version: number;
  definition: {
    cards: string;
    idfc_upi: string;
    impact: string;
  };
  monthly_limit_inr: number;
  gross_amount_inr: number;
  personal_impact: number;
  actual_personal_impact: number;
  forecast_personal_impact: number;
  cashflow_impact: number;
  receivable_amount: number;
  outstanding_receivables: number;
  personal_remaining: number;
  entry_count: number;
  actual_entry_count: number;
  forecast_entry_count: number;
  card_cycles: Array<{
    source: string;
    card_cycle_start: string;
    card_cycle_end: string;
    due_date: string | null;
  }>;
  upi_window: { start: string; end: string };
  groups: Array<Record<string, string | number | null>>;
}

function spendMonthWhere(sourceAlias = ""): string {
  const prefix = sourceAlias ? `${sourceAlias}.` : "";
  return `(
    (${prefix}source IN ('amex', 'bobcard', 'idfc_cc')
      AND substr(${prefix}card_cycle_end, 1, 7) = @spend_month)
    OR
    (${prefix}source = 'idfc_upi'
      AND strftime('%Y-%m', datetime(${prefix}occurred_at, '+5 hours', '+30 minutes')) = @spend_month)
  )`;
}

export function getSpendMonthForEntry(
  entry: Pick<EnvelopeEntry, "source" | "card_cycle_end" | "occurred_at">
): string | null {
  if (entry.source === "amex" || entry.source === "bobcard" || entry.source === "idfc_cc") {
    const cycleMonth = entry.card_cycle_end?.slice(0, 7) ?? "";
    return /^\d{4}-\d{2}$/.test(cycleMonth) ? cycleMonth : null;
  }
  if (entry.source !== "idfc_upi" || !entry.occurred_at) return null;

  const occurredAt = new Date(entry.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const occurredAtIst = new Date(occurredAt.getTime() + 5.5 * 60 * 60 * 1000);
  return `${occurredAtIst.getUTCFullYear()}-${String(occurredAtIst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

/**
 * Canonical monthly-spend view used by every agent.
 *
 * A card entry belongs to the month in which its statement cycle ends. A
 * direct IDFC savings/UPI entry belongs to its IST calendar month. Financial
 * judgment is already represented by personal_impact; this query only applies
 * the user's deterministic month-selection convention.
 */
export function aggregateSpendMonth(
  db: Database.Database,
  filters: { spend_month: string; group_by?: LedgerGroupBy }
): SpendMonthSummary {
  assertFundingMonth(filters.spend_month);
  if (filters.group_by && !("source category treatment state".split(" ") as string[]).includes(filters.group_by)) {
    throw new Error("group_by must be source, category, treatment, or state");
  }

  const params = { spend_month: filters.spend_month };
  const activeWhere = `superseded_at IS NULL AND state != 'cancelled' AND ${spendMonthWhere()}`;
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(gross_amount_inr), 0) AS gross_amount_inr,
        COALESCE(SUM(personal_impact), 0) AS personal_impact,
        COALESCE(SUM(CASE WHEN state = 'forecast' THEN 0 ELSE personal_impact END), 0) AS actual_personal_impact,
        COALESCE(SUM(CASE WHEN state = 'forecast' THEN personal_impact ELSE 0 END), 0) AS forecast_personal_impact,
        COALESCE(SUM(cashflow_impact), 0) AS cashflow_impact,
        COALESCE(SUM(receivable_amount), 0) AS receivable_amount,
        COUNT(*) AS entry_count,
        COALESCE(SUM(CASE WHEN state = 'forecast' THEN 0 ELSE 1 END), 0) AS actual_entry_count,
        COALESCE(SUM(CASE WHEN state = 'forecast' THEN 1 ELSE 0 END), 0) AS forecast_entry_count
       FROM envelope_entries WHERE ${activeWhere}`
    )
    .get(params) as Omit<
      SpendMonthSummary,
      | "spend_month"
      | "definition_version"
      | "definition"
      | "monthly_limit_inr"
      | "outstanding_receivables"
      | "personal_remaining"
      | "card_cycles"
      | "upi_window"
      | "groups"
    >;

  let groups: Array<Record<string, string | number | null>> = [];
  if (filters.group_by) {
    const column = filters.group_by;
    groups = db
      .prepare(
        `SELECT ${column} AS group_key,
          COALESCE(SUM(gross_amount_inr), 0) AS gross_amount_inr,
          COALESCE(SUM(personal_impact), 0) AS personal_impact,
          COALESCE(SUM(CASE WHEN state = 'forecast' THEN 0 ELSE personal_impact END), 0) AS actual_personal_impact,
          COALESCE(SUM(CASE WHEN state = 'forecast' THEN personal_impact ELSE 0 END), 0) AS forecast_personal_impact,
          COALESCE(SUM(cashflow_impact), 0) AS cashflow_impact,
          COALESCE(SUM(receivable_amount), 0) AS receivable_amount,
          COUNT(*) AS entry_count
         FROM envelope_entries WHERE ${activeWhere}
         GROUP BY ${column} ORDER BY personal_impact DESC`
      )
      .all(params) as Array<Record<string, string | number | null>>;
  }

  const outstanding = db
    .prepare(
      `SELECT COALESCE(SUM(r.amount_inr - r.received_inr), 0) AS total
       FROM receivables r
       JOIN envelope_entries e ON e.id = r.envelope_entry_id
       WHERE e.superseded_at IS NULL
         AND e.state != 'cancelled'
         AND r.status IN ('pending', 'partial')
         AND ${spendMonthWhere("e")}`
    )
    .get(params) as { total: number };

  const cardCycles = db
    .prepare(
      `SELECT DISTINCT source, card_cycle_start, card_cycle_end, due_date
       FROM envelope_entries
       WHERE superseded_at IS NULL
         AND state != 'cancelled'
         AND source IN ('amex', 'bobcard', 'idfc_cc')
         AND substr(card_cycle_end, 1, 7) = @spend_month
       ORDER BY card_cycle_end, source`
    )
    .all(params) as SpendMonthSummary["card_cycles"];

  const profile = getActiveSalaryProfile(db);
  const monthlyLimit = profile?.monthly_limit_inr ?? 0;
  return {
    spend_month: filters.spend_month,
    definition_version: 1,
    definition: {
      cards: "include active entries whose card cycle ends in spend_month",
      idfc_upi: "include active entries whose occurrence date falls in spend_month in Asia/Kolkata",
      impact: "sum stored personal_impact; settlements and bookkeeping should already have zero impact",
    },
    monthly_limit_inr: monthlyLimit,
    ...totals,
    outstanding_receivables: outstanding.total,
    personal_remaining: monthlyLimit - totals.personal_impact,
    card_cycles: cardCycles,
    upi_window: { start: `${filters.spend_month}-01`, end: monthEnd(filters.spend_month) },
    groups,
  };
}

export function aggregateEnvelopeEntries(
  db: Database.Database,
  filters: { funding_month: string; source?: string; group_by?: LedgerGroupBy }
): {
  funding_month: string;
  monthly_limit_inr: number;
  gross_amount_inr: number;
  personal_impact: number;
  cashflow_impact: number;
  receivable_amount: number;
  outstanding_receivables: number;
  personal_remaining: number;
  entry_count: number;
  groups: Array<Record<string, string | number | null>>;
} {
  assertFundingMonth(filters.funding_month);
  if (filters.group_by && !(["source", "category", "treatment", "state"] as string[]).includes(filters.group_by)) {
    throw new Error("group_by must be source, category, treatment, or state");
  }
  const params: Record<string, unknown> = { funding_month: filters.funding_month };
  const sourceClause = filters.source ? " AND source = @source" : "";
  if (filters.source) params.source = filters.source;
  const activeWhere = `funding_month = @funding_month AND superseded_at IS NULL AND state != 'cancelled'${sourceClause}`;
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(gross_amount_inr), 0) AS gross_amount_inr,
        COALESCE(SUM(personal_impact), 0) AS personal_impact,
        COALESCE(SUM(cashflow_impact), 0) AS cashflow_impact,
        COALESCE(SUM(receivable_amount), 0) AS receivable_amount,
        COUNT(*) AS entry_count
       FROM envelope_entries WHERE ${activeWhere}`
    )
    .get(params) as {
      gross_amount_inr: number;
      personal_impact: number;
      cashflow_impact: number;
      receivable_amount: number;
      entry_count: number;
    };

  let groups: Array<Record<string, string | number | null>> = [];
  if (filters.group_by) {
    const column = filters.group_by;
    groups = db
      .prepare(
        `SELECT ${column} AS group_key,
          COALESCE(SUM(gross_amount_inr), 0) AS gross_amount_inr,
          COALESCE(SUM(personal_impact), 0) AS personal_impact,
          COALESCE(SUM(cashflow_impact), 0) AS cashflow_impact,
          COALESCE(SUM(receivable_amount), 0) AS receivable_amount,
          COUNT(*) AS entry_count
         FROM envelope_entries WHERE ${activeWhere}
         GROUP BY ${column} ORDER BY personal_impact DESC`
      )
      .all(params) as Array<Record<string, string | number | null>>;
  }

  const profile = getActiveSalaryProfile(db);
  const monthlyLimit = profile?.monthly_limit_inr ?? 0;
  const outstanding = db
    .prepare(
      `SELECT COALESCE(SUM(r.amount_inr - r.received_inr), 0) AS total
       FROM receivables r
       JOIN envelope_entries e ON e.id = r.envelope_entry_id
       WHERE e.funding_month = @funding_month
         AND e.superseded_at IS NULL
         AND r.status IN ('pending', 'partial')${filters.source ? " AND e.source = @source" : ""}`
    )
    .get(params) as { total: number };
  return {
    funding_month: filters.funding_month,
    monthly_limit_inr: monthlyLimit,
    ...totals,
    outstanding_receivables: outstanding.total,
    personal_remaining: monthlyLimit - totals.personal_impact,
    groups,
  };
}

export function listUninterpretedTransactions(
  db: Database.Database,
  filters: { source?: string; since?: string; until?: string; limit?: number } = {}
): RawTransactionV2[] {
  const clauses = ["e.id IS NULL"];
  const params: Record<string, unknown> = { limit: Math.min(Math.max(filters.limit ?? 100, 1), 500) };
  if (filters.source) {
    clauses.push("t.source = @source");
    params.source = filters.source;
  }
  if (filters.since) {
    clauses.push("t.occurred_at >= @since");
    params.since = filters.since;
  }
  if (filters.until) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.until)) {
      const next = new Date(`${filters.until}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      clauses.push("t.occurred_at < @until_exclusive");
      params.until_exclusive = next.toISOString().slice(0, 10);
    } else {
      clauses.push("t.occurred_at <= @until");
      params.until = filters.until;
    }
  }
  return db
    .prepare(
      `SELECT t.* FROM raw_transactions t
       LEFT JOIN envelope_entries e
         ON e.raw_transaction_id = t.id AND e.superseded_at IS NULL
       WHERE ${clauses.join(" AND ")}
       ORDER BY t.occurred_at ASC LIMIT @limit`
    )
    .all(params) as RawTransactionV2[];
}

export function listRawTransactions(
  db: Database.Database,
  filters: { source?: string; direction?: TransactionDirection; since?: string; until?: string; limit?: number } = {}
): RawTransactionV2[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: Math.min(Math.max(filters.limit ?? 100, 1), 1000) };
  if (filters.source) {
    clauses.push("source = @source");
    params.source = filters.source;
  }
  if (filters.direction) {
    clauses.push("direction = @direction");
    params.direction = filters.direction;
  }
  if (filters.since) {
    clauses.push("occurred_at >= @since");
    params.since = filters.since;
  }
  if (filters.until) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.until)) {
      const next = new Date(`${filters.until}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      clauses.push("occurred_at < @until_exclusive");
      params.until_exclusive = next.toISOString().slice(0, 10);
    } else {
      clauses.push("occurred_at <= @until");
      params.until = filters.until;
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM raw_transactions ${where} ORDER BY occurred_at DESC LIMIT @limit`)
    .all(params) as RawTransactionV2[];
}

export function setContextFact(
  db: Database.Database,
  input: { scope_type: ContextScope; scope_id?: string; key: string; value: string; source: string; confidence?: number }
): ContextFact {
  assertConfidence(input.confidence);
  const scopeId = input.scope_id ?? "";
  const operation = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT * FROM context_facts
         WHERE scope_type = ? AND scope_id = ? AND key = ? AND superseded_at IS NULL`
      )
      .get(input.scope_type, scopeId, input.key) as ContextFact | undefined;
    const id = newId();
    if (existing) {
      db.prepare(
        `UPDATE context_facts
         SET superseded_at = datetime('now')
         WHERE id = @id`
      ).run({ id: existing.id });
    }
    db.prepare(
      `INSERT INTO context_facts (
        id, scope_type, scope_id, key, value, source, confidence, supersedes_id
      ) VALUES (@id, @scope_type, @scope_id, @key, @value, @source, @confidence, @supersedes_id)`
    ).run({
      id,
      scope_type: input.scope_type,
      scope_id: scopeId,
      key: input.key,
      value: input.value,
      source: input.source,
      confidence: input.confidence ?? null,
      supersedes_id: existing?.id ?? null,
    });
    if (existing) {
      db.prepare("UPDATE context_facts SET replaced_by_id = ? WHERE id = ?").run(id, existing.id);
    }
    return db.prepare("SELECT * FROM context_facts WHERE id = ?").get(id) as ContextFact;
  });
  return operation();
}

export function listContextFacts(
  db: Database.Database,
  filters: { scope_type?: ContextScope; scope_id?: string; key?: string; include_superseded?: boolean } = {}
): ContextFact[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (!filters.include_superseded) clauses.push("superseded_at IS NULL");
  if (filters.scope_type) {
    clauses.push("scope_type = @scope_type");
    params.scope_type = filters.scope_type;
  }
  if (filters.scope_id !== undefined) {
    clauses.push("scope_id = @scope_id");
    params.scope_id = filters.scope_id;
  }
  if (filters.key) {
    clauses.push("key = @key");
    params.key = filters.key;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM context_facts ${where} ORDER BY created_at DESC`).all(params) as ContextFact[];
}

export function createReceivable(
  db: Database.Database,
  input: {
    envelope_entry_id?: string;
    counterparty: string;
    label: string;
    amount_inr: number;
    received_inr?: number;
    expected_at?: string;
    notes?: string;
    created_by: string;
  }
): Receivable {
  if (!Number.isFinite(input.amount_inr) || input.amount_inr < 0) throw new Error("amount_inr must be non-negative");
  const received = input.received_inr ?? 0;
  if (!Number.isFinite(received) || received < 0 || received > input.amount_inr) {
    throw new Error("received_inr must be between 0 and amount_inr");
  }
  const status: ReceivableStatus = received === 0 ? "pending" : received >= input.amount_inr ? "received" : "partial";
  const id = newId();
  db.prepare(
    `INSERT INTO receivables (
      id, envelope_entry_id, counterparty, label, amount_inr, received_inr,
      status, expected_at, notes, created_by
    ) VALUES (
      @id, @envelope_entry_id, @counterparty, @label, @amount_inr, @received_inr,
      @status, @expected_at, @notes, @created_by
    )`
  ).run({
    id,
    envelope_entry_id: input.envelope_entry_id ?? null,
    counterparty: input.counterparty,
    label: input.label,
    amount_inr: input.amount_inr,
    received_inr: received,
    status,
    expected_at: input.expected_at ?? null,
    notes: input.notes ?? null,
    created_by: input.created_by,
  });
  return db.prepare("SELECT * FROM receivables WHERE id = ?").get(id) as Receivable;
}

export function updateReceivable(
  db: Database.Database,
  id: string,
  updates: { received_inr?: number; status?: ReceivableStatus; expected_at?: string | null; notes?: string | null }
): Receivable | undefined {
  const current = db.prepare("SELECT * FROM receivables WHERE id = ?").get(id) as Receivable | undefined;
  if (!current) return undefined;
  const received = updates.received_inr ?? current.received_inr;
  if (!Number.isFinite(received) || received < 0 || received > current.amount_inr) {
    throw new Error("received_inr must be between 0 and amount_inr");
  }
  const derivedStatus: ReceivableStatus =
    updates.status === "written_off"
      ? "written_off"
      : received === 0
      ? "pending"
      : received >= current.amount_inr
      ? "received"
      : "partial";
  db.prepare(
    `UPDATE receivables SET
      received_inr = @received_inr,
      status = @status,
      expected_at = @expected_at,
      notes = @notes,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    received_inr: received,
    status: derivedStatus,
    expected_at: updates.expected_at === undefined ? current.expected_at : updates.expected_at,
    notes: updates.notes === undefined ? current.notes : updates.notes,
  });
  return db.prepare("SELECT * FROM receivables WHERE id = ?").get(id) as Receivable;
}

export function listReceivables(
  db: Database.Database,
  filters: { status?: ReceivableStatus; counterparty?: string; include_closed?: boolean } = {}
): Receivable[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.status) {
    clauses.push("status = @status");
    params.status = filters.status;
  } else if (!filters.include_closed) {
    clauses.push("status IN ('pending', 'partial')");
  }
  if (filters.counterparty) {
    clauses.push("counterparty = @counterparty");
    params.counterparty = filters.counterparty;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM receivables ${where} ORDER BY created_at DESC`).all(params) as Receivable[];
}

/**
 * Persist a user-confirmed interpretation of an incoming credit atomically.
 * The caller (normally the Telegram AI agent) supplies the semantic allocation;
 * this function only validates accounting consistency and stores the result.
 */
export function recordConfirmedCreditAllocation(
  db: Database.Database,
  input: ConfirmCreditAllocationInput
): { entry: EnvelopeEntry; receivables: Receivable[]; context: ContextFact } {
  const raw = getRawTransaction(db, input.raw_transaction_id);
  if (!raw) throw new Error(`transaction ${input.raw_transaction_id} not found`);
  if (raw.source !== "idfc_upi") throw new Error("credit allocation currently supports IDFC savings/UPI credits");
  if (raw.direction !== "credit") throw new Error("credit allocation requires an incoming credit transaction");
  if (input.allocations.length === 0) throw new Error("at least one allocation is required");
  assertFiniteMoney("personal_impact", input.personal_impact);
  assertFiniteMoney("cashflow_impact", input.cashflow_impact);

  const amountInr = raw.is_international ? raw.amount_inr : raw.amount;
  if (amountInr === null || !Number.isFinite(amountInr)) throw new Error("credit must have a resolved INR amount");
  let allocationTotal = 0;
  for (const allocation of input.allocations) {
    if (!allocation.kind.trim()) throw new Error("allocation kind is required");
    if (!Number.isFinite(allocation.amount_inr) || allocation.amount_inr <= 0) {
      throw new Error("allocation amount_inr must be positive");
    }
    allocationTotal += allocation.amount_inr;
  }
  if (Math.abs(allocationTotal - amountInr) > 0.01) {
    throw new Error(`allocations must total ₹${amountInr}; received ₹${allocationTotal}`);
  }
  if (listEnvelopeEntries(db, { raw_transaction_id: raw.id, limit: 1 }).length > 0) {
    throw new Error("credit transaction already has an active interpretation");
  }

  return db.transaction(() => {
    const updatedReceivables: Receivable[] = [];
    for (const allocation of input.allocations) {
      if (!allocation.receivable_id) continue;
      const receivable = db
        .prepare("SELECT * FROM receivables WHERE id = ?")
        .get(allocation.receivable_id) as Receivable | undefined;
      if (!receivable) throw new Error(`receivable ${allocation.receivable_id} not found`);
      const outstanding = receivable.amount_inr - receivable.received_inr;
      if (allocation.amount_inr - outstanding > 0.01) {
        throw new Error(
          `allocation ₹${allocation.amount_inr} exceeds ₹${outstanding} outstanding for ${receivable.label}`
        );
      }
      const updated = updateReceivable(db, receivable.id, {
        received_inr: receivable.received_inr + allocation.amount_inr,
      });
      if (!updated) throw new Error(`receivable ${receivable.id} could not be updated`);
      updatedReceivables.push(updated);
    }

    const occurredAt = new Date(raw.occurred_at);
    const salaryDay = getActiveSalaryProfile(db)?.salary_day ?? 1;
    const fundingMonth = getSalaryFundingMonthForDate(occurredAt, salaryDay);
    const entry = createEnvelopeEntry(db, {
      raw_transaction_id: raw.id,
      funding_month: fundingMonth,
      occurred_at: raw.occurred_at,
      source: raw.source,
      merchant_clean: raw.merchant_raw ?? undefined,
      category: input.category,
      treatment: input.treatment,
      state: "actual",
      gross_amount_inr: amountInr,
      personal_impact: input.personal_impact,
      cashflow_impact: input.cashflow_impact,
      receivable_amount: 0,
      notes: input.notes,
      confidence: 1,
      created_by: input.created_by,
    });
    const context = setContextFact(db, {
      scope_type: "transaction",
      scope_id: raw.id,
      key: "credit_allocation",
      value: JSON.stringify({
        status: "confirmed",
        amount_inr: amountInr,
        allocations: input.allocations,
        treatment: input.treatment,
        personal_impact: input.personal_impact,
        cashflow_impact: input.cashflow_impact,
        notes: input.notes ?? null,
      }),
      source: input.created_by,
      confidence: 1,
    });
    return { entry, receivables: updatedReceivables, context };
  })();
}

export function createCommitment(
  db: Database.Database,
  input: {
    label: string;
    amount_inr: number;
    frequency?: string;
    start_funding_month: string;
    end_funding_month?: string;
    remaining_occurrences?: number;
    merchant_pattern?: string;
    notes?: string;
    created_by: string;
  }
): Commitment {
  assertFundingMonth(input.start_funding_month);
  if (input.end_funding_month) assertFundingMonth(input.end_funding_month);
  if (!Number.isFinite(input.amount_inr) || input.amount_inr < 0) throw new Error("amount_inr must be non-negative");
  if (input.remaining_occurrences !== undefined && input.remaining_occurrences < 0) {
    throw new Error("remaining_occurrences must be non-negative");
  }
  const id = newId();
  db.prepare(
    `INSERT INTO commitments (
      id, label, amount_inr, frequency, start_funding_month, end_funding_month,
      remaining_occurrences, merchant_pattern, status, notes, created_by
    ) VALUES (
      @id, @label, @amount_inr, @frequency, @start_funding_month, @end_funding_month,
      @remaining_occurrences, @merchant_pattern, 'active', @notes, @created_by
    )`
  ).run({
    id,
    label: input.label,
    amount_inr: input.amount_inr,
    frequency: input.frequency ?? "monthly",
    start_funding_month: input.start_funding_month,
    end_funding_month: input.end_funding_month ?? null,
    remaining_occurrences: input.remaining_occurrences ?? null,
    merchant_pattern: input.merchant_pattern ?? null,
    notes: input.notes ?? null,
    created_by: input.created_by,
  });
  return db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as Commitment;
}

export function updateCommitment(
  db: Database.Database,
  id: string,
  updates: {
    amount_inr?: number;
    end_funding_month?: string | null;
    remaining_occurrences?: number | null;
    status?: CommitmentStatus;
    notes?: string | null;
  }
): Commitment | undefined {
  const current = db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as Commitment | undefined;
  if (!current) return undefined;
  if (updates.amount_inr !== undefined && (!Number.isFinite(updates.amount_inr) || updates.amount_inr < 0)) {
    throw new Error("amount_inr must be non-negative");
  }
  if (updates.end_funding_month) assertFundingMonth(updates.end_funding_month);
  if (updates.remaining_occurrences !== undefined && updates.remaining_occurrences !== null && updates.remaining_occurrences < 0) {
    throw new Error("remaining_occurrences must be non-negative");
  }
  db.prepare(
    `UPDATE commitments SET
      amount_inr = @amount_inr,
      end_funding_month = @end_funding_month,
      remaining_occurrences = @remaining_occurrences,
      status = @status,
      notes = @notes,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    amount_inr: updates.amount_inr ?? current.amount_inr,
    end_funding_month: updates.end_funding_month === undefined ? current.end_funding_month : updates.end_funding_month,
    remaining_occurrences:
      updates.remaining_occurrences === undefined ? current.remaining_occurrences : updates.remaining_occurrences,
    status: updates.status ?? current.status,
    notes: updates.notes === undefined ? current.notes : updates.notes,
  });
  return db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as Commitment;
}

export function listCommitments(
  db: Database.Database,
  filters: { status?: CommitmentStatus; funding_month?: string } = {}
): Commitment[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.status) {
    clauses.push("status = @status");
    params.status = filters.status;
  }
  if (filters.funding_month) {
    assertFundingMonth(filters.funding_month);
    clauses.push("start_funding_month <= @funding_month");
    clauses.push("(end_funding_month IS NULL OR end_funding_month >= @funding_month)");
    params.funding_month = filters.funding_month;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM commitments ${where} ORDER BY label ASC`).all(params) as Commitment[];
}
