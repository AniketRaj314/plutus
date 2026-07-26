import type Database from "better-sqlite3";
import { newId } from "./schema";
import { getSalaryFundingMonthForDate } from "../envelope/engine";

export type EnvelopeEntryState = "forecast" | "actual" | "settled" | "cancelled";
export type ContextScope = "global" | "merchant" | "transaction" | "card" | "person";
export type ReceivableStatus = "pending" | "partial" | "received" | "written_off";
export type CommitmentStatus = "active" | "paused" | "completed" | "cancelled";
export type TransactionDirection = "debit" | "credit";
export type FlexBudgetPlanStatus = "active" | "completed" | "cancelled" | "superseded";
export type FlexBudgetClassification = "flex" | "fixed" | "excluded";
export type FlexBudgetDailyMode = "equal_slice" | "period_pool";

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

export type CounterpartyBalanceItemKind =
  | "expense_you_covered"
  | "money_you_sent"
  | "expense_they_covered"
  | "money_they_sent";

export interface CounterpartyBalanceItem {
  kind: CounterpartyBalanceItemKind;
  label: string;
  amount_inr: number;
  occurred_at: string | null;
  raw_transaction_id: string | null;
  source_id: string;
  notes: string | null;
}

export interface CounterpartyBalanceUncertainItem {
  label: string;
  amount_inr: number;
  occurred_at: string | null;
  raw_transaction_id: string | null;
  source_id: string;
  reason: string;
}

export interface CounterpartyBalanceSummary {
  counterparty: string;
  since: string | null;
  until: string | null;
  value_from_user: CounterpartyBalanceItem[];
  value_from_counterparty: CounterpartyBalanceItem[];
  uncertain: CounterpartyBalanceUncertainItem[];
  total_from_user_inr: number;
  total_from_counterparty_inr: number;
  net_balance_inr: number;
  result: "counterparty_owes_user" | "user_owes_counterparty" | "settled";
  definition: {
    positive_balance: string;
    receivables: string;
    transfers: string;
    manual_obligations: string;
    uncertain: string;
  };
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

export interface FlexBudgetPlan {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  total_target_inr: number;
  timezone: string;
  daily_mode: FlexBudgetDailyMode;
  release_balance_on_last_day: number;
  policy_notes: string | null;
  status: FlexBudgetPlanStatus;
  created_by: string;
  supersedes_id: string | null;
  superseded_at: string | null;
  replaced_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlexBudgetPeriod {
  id: string;
  plan_id: string;
  sequence: number;
  label: string;
  start_date: string;
  end_date: string;
  target_inr: number;
  created_at: string;
}

export interface FlexBudgetClassificationRecord {
  id: string;
  plan_id: string;
  raw_transaction_id: string;
  classification: FlexBudgetClassification;
  impact_override_inr: number | null;
  rationale: string | null;
  confidence: number | null;
  created_by: string;
  supersedes_id: string | null;
  superseded_at: string | null;
  replaced_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlexBudgetPlanWithPeriods extends FlexBudgetPlan {
  periods: FlexBudgetPeriod[];
}

export interface CreateFlexBudgetPlanInput {
  label: string;
  start_date: string;
  end_date: string;
  total_target_inr: number;
  timezone?: string;
  daily_mode?: FlexBudgetDailyMode;
  release_balance_on_last_day?: boolean;
  policy_notes?: string;
  created_by: string;
  supersedes_id?: string;
  periods: Array<{
    label: string;
    start_date: string;
    end_date: string;
    target_inr: number;
  }>;
}

export interface SetFlexBudgetClassificationInput {
  plan_id: string;
  raw_transaction_id: string;
  classification: FlexBudgetClassification;
  impact_override_inr?: number | null;
  rationale?: string;
  confidence?: number;
  created_by: string;
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
    (${prefix}source IN ('amex', 'bobcard', 'idfc_cc', 'icici_cc')
      AND substr(${prefix}card_cycle_end, 1, 7) = @spend_month)
    OR
    (${prefix}source = 'idfc_upi'
      AND strftime('%Y-%m', datetime(${prefix}occurred_at, '+5 hours', '+30 minutes')) = @spend_month)
  )`;
}

export function getSpendMonthForEntry(
  entry: Pick<EnvelopeEntry, "source" | "card_cycle_end" | "occurred_at">
): string | null {
  if (
    entry.source === "amex" ||
    entry.source === "bobcard" ||
    entry.source === "idfc_cc" ||
    entry.source === "icici_cc"
  ) {
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
         AND source IN ('amex', 'bobcard', 'idfc_cc', 'icici_cc')
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

function normalizedCounterparty(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("en-IN");
}

function roundedMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function inCounterpartyWindow(
  occurredAt: string | null,
  filters: { since?: string; until?: string }
): boolean {
  if (!occurredAt) return true;
  const date = occurredAt.slice(0, 10);
  if (filters.since && date < filters.since) return false;
  if (filters.until && date > filters.until) return false;
  return true;
}

function validateCounterpartyWindow(filters: { since?: string; until?: string }): void {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  if (filters.since && !dateOnly.test(filters.since)) throw new Error("since must be YYYY-MM-DD");
  if (filters.until && !dateOnly.test(filters.until)) throw new Error("until must be YYYY-MM-DD");
  if (filters.since && filters.until && filters.since > filters.until) {
    throw new Error("since must be on or before until");
  }
}

function rawDirectionFromEvidence(raw: RawTransactionV2): TransactionDirection {
  const payloadDirection = parseJsonObject(raw.raw_payload)?.direction;
  if (payloadDirection === "credit" || payloadDirection === "debit") return payloadDirection;
  if (raw.amount < 0) return "credit";
  return raw.direction;
}

function rawAmountInr(raw: RawTransactionV2): number {
  return Math.abs(raw.is_international ? raw.amount_inr ?? raw.amount : raw.amount);
}

/**
 * Deterministic two-sided balance view for a person.
 *
 * Financial meaning remains AI/user-authored in existing receivables and
 * context facts. This query deliberately ignores receivable received/partial
 * mutations: original shared expenses stay visible, while confirmed personal
 * transfers appear as independent events on the opposite side.
 */
export function getCounterpartyBalance(
  db: Database.Database,
  counterparty: string,
  filters: { since?: string; until?: string } = {}
): CounterpartyBalanceSummary {
  if (!counterparty.trim()) throw new Error("counterparty is required");
  validateCounterpartyWindow(filters);

  const counterpartyKey = normalizedCounterparty(counterparty);
  const facts = listContextFacts(db);
  const personFacts = facts.filter(
    (fact) =>
      fact.scope_type === "person" &&
      normalizedCounterparty(fact.scope_id) === counterpartyKey
  );
  const exclusions = new Set<string>();
  for (const fact of personFacts.filter((row) => row.key === "counterparty_balance_exclusion")) {
    const value = parseJsonObject(fact.value);
    for (const key of ["source_id", "receivable_id", "raw_transaction_id"]) {
      if (typeof value?.[key] === "string") exclusions.add(value[key] as string);
    }
  }

  const valueFromUser: CounterpartyBalanceItem[] = [];
  const valueFromCounterparty: CounterpartyBalanceItem[] = [];
  const uncertain: CounterpartyBalanceUncertainItem[] = [];
  const accountedRawTransactions = new Set<string>();

  const receivables = listReceivables(db, { include_closed: true }).filter(
    (receivable) => normalizedCounterparty(receivable.counterparty) === counterpartyKey
  );
  for (const receivable of receivables) {
    if (receivable.status === "written_off" || exclusions.has(receivable.id)) continue;
    const entry = receivable.envelope_entry_id
      ? getEnvelopeEntry(db, receivable.envelope_entry_id)
      : undefined;
    const occurredAt = entry?.occurred_at ?? receivable.created_at;
    if (!inCounterpartyWindow(occurredAt, filters)) continue;
    const rawTransactionId = entry?.raw_transaction_id ?? null;
    if (rawTransactionId) accountedRawTransactions.add(rawTransactionId);

    const userConfirmed =
      rawTransactionId !== null &&
      facts.some(
        (fact) =>
          fact.scope_type === "transaction" &&
          fact.scope_id === rawTransactionId &&
          fact.source !== "automatic_inference"
      );
    if (receivable.created_by === "automatic_inference" && !userConfirmed) {
      uncertain.push({
        label: receivable.label,
        amount_inr: roundedMoney(receivable.amount_inr),
        occurred_at: occurredAt,
        raw_transaction_id: rawTransactionId,
        source_id: receivable.id,
        reason: "Created by automatic inference without user-confirmed context.",
      });
      continue;
    }

    valueFromUser.push({
      kind: "expense_you_covered",
      label: receivable.label,
      amount_inr: roundedMoney(receivable.amount_inr),
      occurred_at: occurredAt,
      raw_transaction_id: rawTransactionId,
      source_id: receivable.id,
      notes: receivable.notes,
    });
  }

  for (const fact of personFacts) {
    if (
      !fact.key.startsWith("counterparty_payable_") &&
      !fact.key.startsWith("outstanding_payable_")
    ) {
      continue;
    }
    if (exclusions.has(fact.id)) continue;
    const value = parseJsonObject(fact.value);
    if (!value) continue;
    const status = typeof value.status === "string" ? value.status : "outstanding";
    if (["cancelled", "ignored", "written_off"].includes(status)) continue;
    const amount = Number(value.amount_owed_inr ?? value.amount_inr);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const occurredAt =
      (typeof value.occurred_at === "string" && value.occurred_at) ||
      (typeof value.recorded_on === "string" && value.recorded_on) ||
      fact.created_at;
    if (!inCounterpartyWindow(occurredAt, filters)) continue;
    valueFromCounterparty.push({
      kind: "expense_they_covered",
      label:
        (typeof value.label === "string" && value.label) ||
        fact.key.replace(/^(counterparty|outstanding)_payable_/, "").replaceAll("_", " "),
      amount_inr: roundedMoney(amount),
      occurred_at: occurredAt,
      raw_transaction_id: null,
      source_id: fact.id,
      notes: typeof value.notes === "string" ? value.notes : null,
    });
  }

  const transferFacts = facts.filter(
    (fact) => fact.scope_type === "transaction" && fact.key === "counterparty_transfer"
  );
  for (const fact of transferFacts) {
    if (exclusions.has(fact.id) || exclusions.has(fact.scope_id)) continue;
    const value = parseJsonObject(fact.value);
    if (!value || value.status !== "confirmed") continue;
    const raw = getRawTransaction(db, fact.scope_id);
    const factCounterparty =
      typeof value.counterparty === "string" ? value.counterparty : raw?.merchant_raw;
    if (normalizedCounterparty(factCounterparty) !== counterpartyKey) continue;
    const direction = value.direction;
    if (direction !== "from_counterparty" && direction !== "to_counterparty") continue;
    const amount = Number(value.amount_inr ?? (raw ? rawAmountInr(raw) : NaN));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const occurredAt =
      (typeof value.occurred_at === "string" && value.occurred_at) ||
      raw?.occurred_at ||
      fact.created_at;
    if (!inCounterpartyWindow(occurredAt, filters)) continue;
    const item: CounterpartyBalanceItem = {
      kind: direction === "from_counterparty" ? "money_they_sent" : "money_you_sent",
      label:
        (typeof value.label === "string" && value.label) ||
        (direction === "from_counterparty" ? "Money received" : "Money sent"),
      amount_inr: roundedMoney(amount),
      occurred_at: occurredAt,
      raw_transaction_id: raw?.id ?? fact.scope_id,
      source_id: fact.id,
      notes: typeof value.notes === "string" ? value.notes : null,
    };
    if (direction === "from_counterparty") valueFromCounterparty.push(item);
    else valueFromUser.push(item);
    accountedRawTransactions.add(fact.scope_id);
  }

  // Legacy confirmed allocations identify a personal payment, but their
  // invoice-level splits are intentionally ignored here. The original bank
  // credit is shown once as a standalone human payment.
  const legacyPaymentFacts = facts.filter(
    (fact) => fact.scope_type === "transaction" && fact.key === "credit_allocation"
  );
  for (const fact of legacyPaymentFacts) {
    if (
      accountedRawTransactions.has(fact.scope_id) ||
      exclusions.has(fact.id) ||
      exclusions.has(fact.scope_id)
    ) {
      continue;
    }
    const value = parseJsonObject(fact.value);
    if (!value || value.status !== "confirmed") continue;
    const raw = getRawTransaction(db, fact.scope_id);
    if (!raw || normalizedCounterparty(raw.merchant_raw) !== counterpartyKey) continue;
    if (rawDirectionFromEvidence(raw) !== "credit") continue;
    if (!inCounterpartyWindow(raw.occurred_at, filters)) continue;
    const amount = Number(value.amount_inr ?? rawAmountInr(raw));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    valueFromCounterparty.push({
      kind: "money_they_sent",
      label:
        (typeof value.label === "string" && value.label) ||
        `Money received from ${counterparty}`,
      amount_inr: roundedMoney(amount),
      occurred_at: raw.occurred_at,
      raw_transaction_id: raw.id,
      source_id: fact.id,
      notes: typeof value.notes === "string" ? value.notes : null,
    });
    accountedRawTransactions.add(raw.id);
  }

  const totalFromUser = roundedMoney(
    valueFromUser.reduce((total, item) => total + item.amount_inr, 0)
  );
  const totalFromCounterparty = roundedMoney(
    valueFromCounterparty.reduce((total, item) => total + item.amount_inr, 0)
  );
  const netBalance = roundedMoney(totalFromUser - totalFromCounterparty);

  const byDate = (
    a: CounterpartyBalanceItem | CounterpartyBalanceUncertainItem,
    b: CounterpartyBalanceItem | CounterpartyBalanceUncertainItem
  ) => (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "");
  valueFromUser.sort(byDate);
  valueFromCounterparty.sort(byDate);
  uncertain.sort(byDate);

  return {
    counterparty,
    since: filters.since ?? null,
    until: filters.until ?? null,
    value_from_user: valueFromUser,
    value_from_counterparty: valueFromCounterparty,
    uncertain,
    total_from_user_inr: totalFromUser,
    total_from_counterparty_inr: totalFromCounterparty,
    net_balance_inr: netBalance,
    result:
      netBalance > 0
        ? "counterparty_owes_user"
        : netBalance < 0
        ? "user_owes_counterparty"
        : "settled",
    definition: {
      positive_balance: "A positive net means the counterparty owes the user.",
      receivables:
        "Original personal receivable amounts remain visible regardless of partial/received status.",
      transfers:
        "Confirmed person-to-person transfers are independent opposite-side events; invoice allocations are ignored.",
      manual_obligations:
        "Person-scoped payable facts represent expenses the counterparty covered outside tracked accounts.",
      uncertain: "Unconfirmed automatic inferences are listed separately and excluded from the net.",
    },
  };
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

function assertDateOnly(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysInclusive(startDate: string, endDate: string): number {
  return Math.round(
    (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) /
      (24 * 60 * 60 * 1000)
  ) + 1;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function todayDateInIst(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function getFlexBudgetPlan(
  db: Database.Database,
  id: string
): FlexBudgetPlanWithPeriods | undefined {
  const plan = db.prepare("SELECT * FROM flex_budget_plans WHERE id = ?").get(id) as
    | FlexBudgetPlan
    | undefined;
  if (!plan) return undefined;
  const periods = db
    .prepare("SELECT * FROM flex_budget_periods WHERE plan_id = ? ORDER BY sequence ASC")
    .all(id) as FlexBudgetPeriod[];
  return { ...plan, periods };
}

export function listFlexBudgetPlans(
  db: Database.Database,
  filters: { status?: FlexBudgetPlanStatus; on_date?: string } = {}
): FlexBudgetPlanWithPeriods[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.status) {
    clauses.push("status = @status");
    params.status = filters.status;
  }
  if (filters.on_date) {
    assertDateOnly("on_date", filters.on_date);
    clauses.push("start_date <= @on_date AND end_date >= @on_date");
    params.on_date = filters.on_date;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const plans = db
    .prepare(`SELECT * FROM flex_budget_plans ${where} ORDER BY created_at DESC`)
    .all(params) as FlexBudgetPlan[];
  return plans.map((plan) => getFlexBudgetPlan(db, plan.id) as FlexBudgetPlanWithPeriods);
}

export function getActiveFlexBudgetPlan(
  db: Database.Database,
  onDate = todayDateInIst()
): FlexBudgetPlanWithPeriods | undefined {
  return listFlexBudgetPlans(db, { status: "active", on_date: onDate })[0];
}

export function createFlexBudgetPlan(
  db: Database.Database,
  input: CreateFlexBudgetPlanInput
): FlexBudgetPlanWithPeriods {
  assertDateOnly("start_date", input.start_date);
  assertDateOnly("end_date", input.end_date);
  if (input.end_date < input.start_date) throw new Error("end_date must be on or after start_date");
  if (!Number.isFinite(input.total_target_inr) || input.total_target_inr < 0) {
    throw new Error("total_target_inr must be non-negative");
  }
  if ((input.timezone ?? "Asia/Kolkata") !== "Asia/Kolkata") {
    throw new Error("only Asia/Kolkata is currently supported");
  }
  if (input.periods.length === 0) throw new Error("at least one flex budget period is required");
  const overlapping = db
    .prepare(
      `SELECT id FROM flex_budget_plans
       WHERE status = 'active'
         AND start_date <= @end_date
         AND end_date >= @start_date
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get({ start_date: input.start_date, end_date: input.end_date }) as { id: string } | undefined;
  if (overlapping && overlapping.id !== input.supersedes_id) {
    throw new Error(
      `active flex budget plan ${overlapping.id} overlaps this window; revise it with supersedes_id`
    );
  }

  const periods = input.periods.map((period) => ({ ...period }));
  let expectedStart = input.start_date;
  let targetSum = 0;
  for (const [index, period] of periods.entries()) {
    assertDateOnly(`periods[${index}].start_date`, period.start_date);
    assertDateOnly(`periods[${index}].end_date`, period.end_date);
    if (period.start_date !== expectedStart) {
      throw new Error("flex budget periods must be ordered, contiguous, and cover the plan");
    }
    if (period.end_date < period.start_date || period.end_date > input.end_date) {
      throw new Error("flex budget period dates must fall within the plan");
    }
    if (!Number.isFinite(period.target_inr) || period.target_inr < 0) {
      throw new Error("period target_inr must be non-negative");
    }
    targetSum += period.target_inr;
    expectedStart = addDays(period.end_date, 1);
  }
  if (periods[periods.length - 1].end_date !== input.end_date) {
    throw new Error("flex budget periods must cover the plan end date");
  }
  if (Math.abs(targetSum - input.total_target_inr) > 0.01) {
    throw new Error("period targets must add up to total_target_inr");
  }

  return db.transaction(() => {
    const id = newId();
    let replaced: FlexBudgetPlan | undefined;
    if (input.supersedes_id) {
      replaced = db.prepare("SELECT * FROM flex_budget_plans WHERE id = ?").get(input.supersedes_id) as
        | FlexBudgetPlan
        | undefined;
      if (!replaced) throw new Error(`flex budget plan ${input.supersedes_id} not found`);
      if (replaced.status !== "active") throw new Error("only an active flex budget plan can be superseded");
      db.prepare(
        `UPDATE flex_budget_plans
         SET status = 'superseded', superseded_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(replaced.id);
    }

    db.prepare(
      `INSERT INTO flex_budget_plans (
        id, label, start_date, end_date, total_target_inr, timezone, daily_mode,
        release_balance_on_last_day, policy_notes, status, created_by, supersedes_id
      ) VALUES (
        @id, @label, @start_date, @end_date, @total_target_inr, @timezone, @daily_mode,
        @release_balance_on_last_day, @policy_notes, 'active', @created_by, @supersedes_id
      )`
    ).run({
      id,
      label: input.label,
      start_date: input.start_date,
      end_date: input.end_date,
      total_target_inr: input.total_target_inr,
      timezone: input.timezone ?? "Asia/Kolkata",
      daily_mode: input.daily_mode ?? "equal_slice",
      release_balance_on_last_day: input.release_balance_on_last_day === false ? 0 : 1,
      policy_notes: input.policy_notes ?? null,
      created_by: input.created_by,
      supersedes_id: input.supersedes_id ?? null,
    });

    const insertPeriod = db.prepare(
      `INSERT INTO flex_budget_periods (
        id, plan_id, sequence, label, start_date, end_date, target_inr
      ) VALUES (
        @id, @plan_id, @sequence, @label, @start_date, @end_date, @target_inr
      )`
    );
    periods.forEach((period, sequence) => {
      insertPeriod.run({ id: newId(), plan_id: id, sequence, ...period });
    });
    if (replaced) {
      const inherited = db
        .prepare(
          `SELECT c.*
           FROM flex_budget_classifications c
           JOIN raw_transactions r ON r.id = c.raw_transaction_id
           WHERE c.plan_id = @replaced_plan_id
             AND c.superseded_at IS NULL
             AND date(datetime(r.occurred_at, '+5 hours', '+30 minutes'))
               BETWEEN @start_date AND @end_date`
        )
        .all({
          replaced_plan_id: replaced.id,
          start_date: input.start_date,
          end_date: input.end_date,
        }) as FlexBudgetClassificationRecord[];
      const insertClassification = db.prepare(
        `INSERT INTO flex_budget_classifications (
          id, plan_id, raw_transaction_id, classification, impact_override_inr,
          rationale, confidence, created_by
        ) VALUES (
          @id, @plan_id, @raw_transaction_id, @classification, @impact_override_inr,
          @rationale, @confidence, @created_by
        )`
      );
      inherited.forEach((classification) => {
        insertClassification.run({
          id: newId(),
          plan_id: id,
          raw_transaction_id: classification.raw_transaction_id,
          classification: classification.classification,
          impact_override_inr: classification.impact_override_inr,
          rationale: classification.rationale,
          confidence: classification.confidence,
          created_by: classification.created_by,
        });
      });
      db.prepare("UPDATE flex_budget_plans SET replaced_by_id = ? WHERE id = ?").run(id, replaced.id);
    }
    return getFlexBudgetPlan(db, id) as FlexBudgetPlanWithPeriods;
  })();
}

export function setFlexBudgetClassification(
  db: Database.Database,
  input: SetFlexBudgetClassificationInput
): FlexBudgetClassificationRecord {
  assertConfidence(input.confidence);
  assertFiniteMoney("impact_override_inr", input.impact_override_inr ?? undefined);
  const plan = getFlexBudgetPlan(db, input.plan_id);
  if (!plan) throw new Error(`flex budget plan ${input.plan_id} not found`);
  const raw = getRawTransaction(db, input.raw_transaction_id);
  if (!raw) throw new Error(`raw transaction ${input.raw_transaction_id} not found`);
  const rawDate = db
    .prepare(
      `SELECT date(datetime(occurred_at, '+5 hours', '+30 minutes')) AS occurred_date
       FROM raw_transactions WHERE id = ?`
    )
    .get(input.raw_transaction_id) as { occurred_date: string };
  if (rawDate.occurred_date < plan.start_date || rawDate.occurred_date > plan.end_date) {
    throw new Error("transaction falls outside the flex budget plan");
  }

  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT * FROM flex_budget_classifications
         WHERE plan_id = ? AND raw_transaction_id = ? AND superseded_at IS NULL`
      )
      .get(input.plan_id, input.raw_transaction_id) as FlexBudgetClassificationRecord | undefined;
    const id = newId();
    if (existing) {
      db.prepare(
        `UPDATE flex_budget_classifications
         SET superseded_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(existing.id);
    }
    db.prepare(
      `INSERT INTO flex_budget_classifications (
        id, plan_id, raw_transaction_id, classification, impact_override_inr,
        rationale, confidence, created_by, supersedes_id
      ) VALUES (
        @id, @plan_id, @raw_transaction_id, @classification, @impact_override_inr,
        @rationale, @confidence, @created_by, @supersedes_id
      )`
    ).run({
      id,
      plan_id: input.plan_id,
      raw_transaction_id: input.raw_transaction_id,
      classification: input.classification,
      impact_override_inr: input.impact_override_inr ?? null,
      rationale: input.rationale ?? null,
      confidence: input.confidence ?? null,
      created_by: input.created_by,
      supersedes_id: existing?.id ?? null,
    });
    if (existing) {
      db.prepare("UPDATE flex_budget_classifications SET replaced_by_id = ? WHERE id = ?").run(id, existing.id);
    }
    return db.prepare("SELECT * FROM flex_budget_classifications WHERE id = ?").get(id) as
      FlexBudgetClassificationRecord;
  })();
}

interface FlexBudgetLedgerRow {
  raw_transaction_id: string;
  occurred_at: string;
  occurred_date: string;
  source: string;
  merchant_raw: string | null;
  direction: TransactionDirection;
  envelope_entry_id: string | null;
  merchant_clean: string | null;
  category: string | null;
  treatment: string | null;
  state: EnvelopeEntryState | null;
  personal_impact: number | null;
  classification_id: string | null;
  classification: FlexBudgetClassification | null;
  impact_override_inr: number | null;
  rationale: string | null;
}

export interface FlexBudgetStatus {
  as_of: string;
  exact: boolean;
  plan: FlexBudgetPlanWithPeriods;
  plan_spent_inr: number;
  plan_remaining_inr: number;
  current_period: null | {
    id: string;
    label: string;
    start_date: string;
    end_date: string;
    nominal_target_inr: number;
    carry_in_inr: number;
    effective_target_inr: number;
    spent_inr: number;
    remaining_inr: number;
    available_inr: number;
  };
  today: null | {
    date: string;
    nominal_target_inr: number;
    spent_inr: number;
    remaining_inr: number;
    is_period_last_day: boolean;
  };
  periods: Array<{
    id: string;
    label: string;
    start_date: string;
    end_date: string;
    nominal_target_inr: number;
    adjusted_target_inr: number;
    spent_inr: number;
    remaining_inr: number;
  }>;
  transactions: Array<{
    raw_transaction_id: string;
    occurred_at: string;
    occurred_date: string;
    source: string;
    merchant: string;
    treatment: string | null;
    classification: FlexBudgetClassification;
    personal_impact_inr: number;
    flex_impact_inr: number;
    rationale: string | null;
  }>;
  unresolved: Array<{
    raw_transaction_id: string;
    occurred_at: string;
    source: string;
    merchant: string;
    reason: "awaiting_interpretation" | "awaiting_flex_classification";
  }>;
}

export function getFlexBudgetStatus(
  db: Database.Database,
  input: { plan_id?: string; as_of?: string } = {}
): FlexBudgetStatus | { error: string } {
  const asOf = input.as_of ?? todayDateInIst();
  assertDateOnly("as_of", asOf);
  const plan = input.plan_id
    ? getFlexBudgetPlan(db, input.plan_id)
    : getActiveFlexBudgetPlan(db, asOf);
  if (!plan) return { error: "no flex budget plan found for this date" };

  const rows = db
    .prepare(
      `SELECT
        r.id AS raw_transaction_id,
        r.occurred_at,
        date(datetime(r.occurred_at, '+5 hours', '+30 minutes')) AS occurred_date,
        r.source,
        r.merchant_raw,
        r.direction,
        e.id AS envelope_entry_id,
        e.merchant_clean,
        e.category,
        e.treatment,
        e.state,
        e.personal_impact,
        c.id AS classification_id,
        c.classification,
        c.impact_override_inr,
        c.rationale
       FROM raw_transactions r
       LEFT JOIN envelope_entries e
         ON e.raw_transaction_id = r.id AND e.superseded_at IS NULL
       LEFT JOIN flex_budget_classifications c
         ON c.plan_id = @plan_id
        AND c.raw_transaction_id = r.id
        AND c.superseded_at IS NULL
       WHERE date(datetime(r.occurred_at, '+5 hours', '+30 minutes'))
         BETWEEN @start_date AND @end_date
       ORDER BY r.occurred_at ASC`
    )
    .all({ plan_id: plan.id, start_date: plan.start_date, end_date: plan.end_date }) as FlexBudgetLedgerRow[];

  const consideredRows = rows.filter((row) => row.occurred_date <= asOf);
  const resolvedRows = consideredRows.filter(
    (row) => row.envelope_entry_id && row.classification_id && row.state !== "cancelled"
  );
  const transactions = resolvedRows.map((row) => {
    const personalImpact = row.personal_impact ?? 0;
    const flexImpact = roundMoney(
      row.classification === "flex"
        ? row.impact_override_inr ?? personalImpact
        : 0
    );
    return {
      raw_transaction_id: row.raw_transaction_id,
      occurred_at: row.occurred_at,
      occurred_date: row.occurred_date,
      source: row.source,
      merchant: row.merchant_clean ?? row.merchant_raw ?? "Unknown",
      treatment: row.treatment,
      classification: row.classification as FlexBudgetClassification,
      personal_impact_inr: personalImpact,
      flex_impact_inr: flexImpact,
      rationale: row.rationale,
    };
  });
  const unresolved = consideredRows
    .filter((row) => !row.envelope_entry_id || !row.classification_id)
    .map((row) => ({
      raw_transaction_id: row.raw_transaction_id,
      occurred_at: row.occurred_at,
      source: row.source,
      merchant: row.merchant_clean ?? row.merchant_raw ?? "Unknown",
      reason: (row.envelope_entry_id
        ? "awaiting_flex_classification"
        : "awaiting_interpretation") as "awaiting_interpretation" | "awaiting_flex_classification",
    }));

  const spentForRange = (startDate: string, endDate: string): number =>
    roundMoney(
      transactions
        .filter((row) => row.occurred_date >= startDate && row.occurred_date <= endDate)
        .reduce((sum, row) => sum + row.flex_impact_inr, 0)
    );

  let completedCarry = 0;
  const periodStatuses = plan.periods.map((period) => {
    const spent = spentForRange(period.start_date, period.end_date < asOf ? period.end_date : asOf);
    const isPast = period.end_date < asOf;
    const isCurrent = period.start_date <= asOf && period.end_date >= asOf;
    const adjustedTarget = roundMoney(period.target_inr + completedCarry);
    const remaining = roundMoney(adjustedTarget - spent);
    if (isPast) {
      completedCarry = remaining;
    } else if (isCurrent && remaining < 0) {
      completedCarry = remaining;
    } else if (!isCurrent) {
      completedCarry = 0;
    }
    return {
      id: period.id,
      label: period.label,
      start_date: period.start_date,
      end_date: period.end_date,
      nominal_target_inr: period.target_inr,
      adjusted_target_inr: adjustedTarget,
      spent_inr: spent,
      remaining_inr: remaining,
    };
  });

  const currentIndex = plan.periods.findIndex(
    (period) => period.start_date <= asOf && period.end_date >= asOf
  );
  const currentPeriod = currentIndex >= 0 ? plan.periods[currentIndex] : undefined;
  const currentPeriodStatus = currentIndex >= 0 ? periodStatuses[currentIndex] : undefined;
  const priorNominal = currentIndex > 0
    ? plan.periods.slice(0, currentIndex).reduce((sum, period) => sum + period.target_inr, 0)
    : 0;
  const priorSpent = currentIndex > 0
    ? spentForRange(plan.start_date, addDays(currentPeriod?.start_date ?? plan.start_date, -1))
    : 0;
  const carryIn = roundMoney(priorNominal - priorSpent);
  const effectiveTarget = currentPeriod ? roundMoney(currentPeriod.target_inr + carryIn) : 0;
  const currentSpent = currentPeriod
    ? spentForRange(currentPeriod.start_date, asOf)
    : 0;
  const currentRemaining = roundMoney(effectiveTarget - currentSpent);
  const todaySpent = spentForRange(asOf, asOf);
  const isLastDay = currentPeriod?.end_date === asOf;
  const nominalDailyTarget = currentPeriod
    ? roundMoney(currentPeriod.target_inr / daysInclusive(currentPeriod.start_date, currentPeriod.end_date))
    : 0;
  const dailyAvailable =
    plan.daily_mode === "period_pool" || (plan.release_balance_on_last_day && isLastDay)
      ? Math.max(0, currentRemaining)
      : Math.max(0, roundMoney(nominalDailyTarget - todaySpent));
  const planSpent = spentForRange(plan.start_date, asOf);

  return {
    as_of: asOf,
    exact: unresolved.length === 0,
    plan,
    plan_spent_inr: planSpent,
    plan_remaining_inr: roundMoney(plan.total_target_inr - planSpent),
    current_period:
      currentPeriod && currentPeriodStatus
        ? {
            id: currentPeriod.id,
            label: currentPeriod.label,
            start_date: currentPeriod.start_date,
            end_date: currentPeriod.end_date,
            nominal_target_inr: currentPeriod.target_inr,
            carry_in_inr: carryIn,
            effective_target_inr: effectiveTarget,
            spent_inr: currentSpent,
            remaining_inr: currentRemaining,
            available_inr: Math.max(0, currentRemaining),
          }
        : null,
    today: currentPeriod
      ? {
          date: asOf,
          nominal_target_inr: nominalDailyTarget,
          spent_inr: todaySpent,
          remaining_inr: dailyAvailable,
          is_period_last_day: Boolean(isLastDay),
        }
      : null,
    periods: periodStatuses,
    transactions,
    unresolved,
  };
}
