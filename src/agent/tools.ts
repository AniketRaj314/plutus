import type Database from "better-sqlite3";
import {
  getEnvelope,
  queryTransactions,
  getTransaction,
  updateTransaction,
  insertTransaction,
  deleteTransaction,
  insertSplit,
  updateSplit,
  deleteSplit,
  listAllSplits,
  insertCommittedExpense,
  getCommittedExpense,
  deleteCommittedExpense,
  listTransactions,
  setContext,
  getContext,
  listContext,
  getCreditCard,
  updateEnvelope,
  type Transaction,
  type NewTransaction,
} from "../db/queries";
import { newId } from "../db/schema";
import {
  applyTransaction,
  recalculateEnvelope,
  reconcileEnvelopeFromTransactions,
  getEnvelopeState,
  getBillingWindow,
} from "../envelope/engine";
import { enrichTransaction } from "../enrichment/gpt";
import { v2Tools } from "./v2-tools";
import { insertRawTransaction } from "../db/v2-queries";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (db: Database.Database, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

// -- get_envelope --

function getEnvelopeTool(db: Database.Database): unknown {
  const envelope = getEnvelopeState(db);
  if (!envelope) return { error: "envelope not configured yet" };

  const weekRemaining = (envelope.current_week_budget ?? 0) - (envelope.current_week_spent ?? 0);
  const weekSpentPct = envelope.current_week_budget
    ? round2(((envelope.current_week_spent ?? 0) / envelope.current_week_budget) * 100)
    : 0;
  const monthSpentPct = envelope.discretionary_pool
    ? round2(((envelope.spent_discretionary ?? 0) / envelope.discretionary_pool) * 100)
    : 0;

  return {
    ...envelope,
    week_remaining: round2(weekRemaining),
    week_spent_pct: weekSpentPct,
    month_spent_pct: monthSpentPct,
  };
}

// -- get_transactions --

interface GetTransactionsArgs {
  since?: string;
  until?: string;
  source?: string;
  category?: string;
  min_amount?: number;
  limit?: number;
}

function getTransactionsTool(db: Database.Database, args: GetTransactionsArgs): unknown {
  return queryTransactions(db, args);
}

// -- update_transaction --

interface UpdateTransactionArgs {
  id: string;
  category?: string;
  notes?: string;
  is_committed?: boolean;
  merchant_clean?: string;
  merchant_raw?: string;
  is_cancelled_out?: boolean;
  amount_inr?: number;
  amount?: number;
  datetime?: string;
  card_last4?: string;
}

function updateTransactionTool(db: Database.Database, args: UpdateTransactionArgs): unknown {
  const existing = getTransaction(db, args.id);
  if (!existing) return { error: `transaction ${args.id} not found` };

  const updates: Partial<NewTransaction> = {};
  if (args.category !== undefined) updates.category = args.category;
  if (args.notes !== undefined) updates.notes = args.notes;
  if (args.is_committed !== undefined) updates.is_committed = args.is_committed ? 1 : 0;
  if (args.merchant_clean !== undefined) updates.merchant_clean = args.merchant_clean;
  if (args.merchant_raw !== undefined) updates.merchant_raw = args.merchant_raw;
  if (args.is_cancelled_out !== undefined) updates.is_cancelled_out = args.is_cancelled_out ? 1 : 0;
  if (args.datetime !== undefined) updates.datetime = args.datetime;
  if (args.card_last4 !== undefined) updates.card_last4 = args.card_last4;

  // Correcting the amount (whether resolving forex via amount_inr, or fixing
  // a misparsed amount directly) affects money already deducted from the
  // envelope — reverse the old deduction and let applyTransaction re-deduct
  // the corrected one, bypassing its idempotency guard since this is a
  // deliberate amendment, not an accidental retry.
  const affectsEnvelope = args.amount_inr !== undefined || args.amount !== undefined;

  if (affectsEnvelope && existing.envelope_applied) {
    const reversedMagnitude = existing.envelope_impact ?? existing.amount ?? 0;
    const envelope = getEnvelope(db);
    if (envelope) {
      updateEnvelope(db, {
        current_week_spent: (envelope.current_week_spent ?? 0) - reversedMagnitude,
        spent_discretionary: (envelope.spent_discretionary ?? 0) - reversedMagnitude,
      });
    }
  }

  if (affectsEnvelope) {
    updates.envelope_applied = 0;
    if (args.amount_inr !== undefined) {
      updates.amount_inr = args.amount_inr;
      updates.envelope_impact = args.amount_inr;
    }
    if (args.amount !== undefined) {
      updates.amount = args.amount;
    }
  }

  const updated = updateTransaction(db, args.id, updates);
  if (!updated) return { error: `transaction ${args.id} not found` };

  if (!affectsEnvelope) {
    return { transaction: updated };
  }

  const applyResult = applyTransaction(db, updated);
  return {
    transaction: getTransaction(db, args.id),
    apply_result: applyResult,
    envelope: getEnvelopeState(db),
  };
}

// -- mark_as_split --

interface MarkAsSplitArgs {
  transaction_id: string;
  your_share: number;
  paid_by_you: boolean;
  people: Array<{ name: string; amount: number }>;
}

function markAsSplitTool(db: Database.Database, args: MarkAsSplitArgs): unknown {
  const transaction = getTransaction(db, args.transaction_id);
  if (!transaction) return { error: `transaction ${args.transaction_id} not found` };

  const originalMagnitude = transaction.envelope_impact ?? transaction.amount ?? 0;
  const wasApplied = !!transaction.envelope_applied;

  const split = insertSplit(db, {
    transaction_id: args.transaction_id,
    total_amount: transaction.amount,
    your_share: args.your_share,
    paid_by_you: args.paid_by_you ? 1 : 0,
    people: JSON.stringify(args.people.map((p) => ({ name: p.name, amount_owed: p.amount, settled: false }))),
    settled: 0,
  });

  updateTransaction(db, args.transaction_id, { split_id: split.id, envelope_impact: args.your_share });

  // Reverse the originally-applied full amount, then apply just your_share
  // below, bypassing applyTransaction's idempotency guard since this is a
  // deliberate amendment (not an accidental retry).
  if (wasApplied) {
    const envelope = getEnvelope(db);
    if (envelope) {
      updateEnvelope(db, {
        current_week_spent: (envelope.current_week_spent ?? 0) - originalMagnitude,
        spent_discretionary: (envelope.spent_discretionary ?? 0) - originalMagnitude,
      });
    }
  }

  updateTransaction(db, args.transaction_id, { envelope_applied: 0 });
  const finalTransaction = getTransaction(db, args.transaction_id) as Transaction;
  const applyResult = applyTransaction(db, finalTransaction);

  return {
    split,
    transaction: getTransaction(db, args.transaction_id),
    apply_result: applyResult,
    envelope: getEnvelopeState(db),
  };
}

// -- settle_split --

function settleSplitTool(db: Database.Database, args: { split_id: string }): unknown {
  const updated = updateSplit(db, args.split_id, { settled: 1 });
  if (!updated) return { error: `split ${args.split_id} not found` };
  return { split: updated };
}

// -- set_committed_expense --

interface SetCommittedExpenseArgs {
  label: string;
  merchant_pattern?: string;
  vpa?: string;
  amount_approx: number;
}

function setCommittedExpenseTool(db: Database.Database, args: SetCommittedExpenseArgs): unknown {
  const committedExpense = insertCommittedExpense(db, {
    label: args.label,
    merchant_pattern: args.merchant_pattern ?? null,
    vpa: args.vpa ?? null,
    amount_approx: args.amount_approx,
    is_recurring: 1,
  });

  const envelope = recalculateEnvelopeTool(db);
  return { committed_expense: committedExpense, envelope };
}

// -- recalculate_envelope --

function recalculateEnvelopeTool(db: Database.Database): unknown {
  const envelope = recalculateEnvelope(db);
  return envelope;
}

// -- get_summary --

interface GetSummaryArgs {
  period: "week" | "month";
}

function getSummaryTool(db: Database.Database, args: GetSummaryArgs): unknown {
  const envelope = getEnvelopeState(db);
  const all = listTransactions(db, 2000);

  let sinceIso: string;
  if (args.period === "week" && envelope?.current_week_start) {
    sinceIso = `${envelope.current_week_start}T00:00:00.000Z`;
  } else {
    const month = envelope?.month ?? new Date().toISOString().slice(0, 7);
    sinceIso = `${month}-01T00:00:00.000Z`;
  }

  const inPeriod = all.filter((t) => t.datetime && t.datetime >= sinceIso);

  let totalSpent = 0;
  const byCategory: Record<string, number> = {};
  const byMerchant: Record<string, number> = {};
  let internationalPendingCount = 0;
  let includedTransactionCount = 0;

  for (const t of inPeriod) {
    if (t.is_cancelled_out || t.is_credit_card_payment) continue;
    if (t.is_international && t.amount_inr === null) {
      internationalPendingCount++;
      continue;
    }
    const amount = t.is_international ? t.amount_inr ?? 0 : t.amount ?? 0;
    const signed = t.is_reversal ? -amount : amount;
    totalSpent += signed;
    includedTransactionCount++;

    const category = t.category ?? "Uncategorized";
    byCategory[category] = (byCategory[category] ?? 0) + signed;

    const merchant = t.merchant_clean ?? t.merchant_raw ?? "Unknown";
    byMerchant[merchant] = (byMerchant[merchant] ?? 0) + signed;

  }

  return {
    metric: "legacy_raw_activity_inr",
    warning: "Raw calendar activity is not true personal spend. Use get_funding_summary for salary-envelope reasoning.",
    total_spent: round2(totalSpent),
    by_category: Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({ category, amount: round2(amount) })),
    top_merchants: Object.entries(byMerchant)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([merchant, amount]) => ({ merchant, amount: round2(amount) })),
    envelope_state: envelope,
    transaction_count: includedTransactionCount,
    international_pending_count: internationalPendingCount,
  };
}

// -- get_splits_owed --

function getSplitsOwedTool(db: Database.Database): unknown {
  const unsettled = listAllSplits(db).filter((s) => !s.settled && s.paid_by_you);
  const grouped: Record<string, { total: number; items: Array<{ split_id: string; transaction_id: string | null; amount: number }> }> = {};

  for (const s of unsettled) {
    let people: Array<{ name: string; amount_owed: number; settled?: boolean }> = [];
    try {
      people = s.people ? JSON.parse(s.people) : [];
    } catch {
      people = [];
    }

    for (const p of people) {
      if (p.settled) continue;
      if (!grouped[p.name]) grouped[p.name] = { total: 0, items: [] };
      grouped[p.name].total += p.amount_owed;
      grouped[p.name].items.push({ split_id: s.id, transaction_id: s.transaction_id, amount: p.amount_owed });
    }
  }

  return Object.entries(grouped).map(([name, data]) => ({
    name,
    total_owed: round2(data.total),
    items: data.items,
  }));
}

// -- set_context / get_context --

function setContextTool(db: Database.Database, args: { key: string; value: string }): unknown {
  setContext(db, args.key, args.value);
  return { ok: true };
}

function getContextTool(db: Database.Database, args: { key: string }): unknown {
  const row = getContext(db, args.key);
  return { value: row?.value ?? null };
}

// -- get_card_billing_window --

function getCardBillingWindowTool(db: Database.Database, args: { source: string }): unknown {
  const card = getCreditCard(db, args.source);
  if (!card) return { error: `unknown card source "${args.source}"` };

  const window = getBillingWindow(card, new Date());
  return {
    card,
    window_start: window.start,
    window_end: window.end,
    due_day: card.due_day,
  };
}

// -- create_transaction / bulk_create_transactions --

interface CreateTransactionArgs {
  source: string;
  amount: number;
  merchant_raw: string;
  merchant_clean?: string;
  category?: string;
  datetime: string;
  card_last4?: string;
  currency?: string;
  amount_inr?: number;
  is_committed?: boolean;
  is_cancelled_out?: boolean;
  is_reversal?: boolean;
  is_international?: boolean;
  is_preauth?: boolean;
  envelope_impact?: number;
  notes?: string;
}

async function createTransactionTool(db: Database.Database, args: CreateTransactionArgs): Promise<unknown> {
  const manualRawEmailId = `manual_backfill_${newId()}`;
  const created = insertTransaction(db, {
    source: args.source,
    amount: args.amount,
    merchant_raw: args.merchant_raw,
    merchant_clean: args.merchant_clean,
    category: args.category,
    datetime: args.datetime,
    card_last4: args.card_last4,
    currency: args.currency ?? "INR",
    amount_inr: args.amount_inr,
    is_committed: args.is_committed ? 1 : 0,
    is_cancelled_out: args.is_cancelled_out ? 1 : 0,
    is_reversal: args.is_reversal ? 1 : 0,
    is_international: args.is_international ? 1 : 0,
    is_preauth: args.is_preauth ? 1 : 0,
    envelope_impact: args.envelope_impact,
    notes: args.notes,
    // Marks the row as manually created so email-dedup logic never mistakes
    // it for (or gets confused by) a real Gmail-sourced transaction.
    raw_email_id: manualRawEmailId,
  });

  insertRawTransaction(db, {
    id: created.id,
    source: args.source,
    amount: args.amount,
    currency: args.currency ?? "INR",
    amount_inr: args.amount_inr,
    merchant_raw: args.merchant_raw,
    occurred_at: args.datetime,
    card_last4: args.card_last4,
    is_reversal: args.is_reversal,
    is_international: args.is_international,
    is_preauth: args.is_preauth,
    raw_email_id: manualRawEmailId,
    raw_payload: JSON.stringify({ origin: "manual_backfill" }),
  });

  const hasCleanData = args.merchant_clean !== undefined && args.category !== undefined;
  if (!hasCleanData) {
    await enrichTransaction(db, created);
  }

  const enriched = getTransaction(db, created.id) as Transaction;
  const applyResult = applyTransaction(db, enriched);

  return {
    transaction: getTransaction(db, created.id),
    apply_result: applyResult,
    envelope: getEnvelopeState(db),
  };
}

interface BulkCreateTransactionsArgs {
  transactions: CreateTransactionArgs[];
}

interface BulkCreateResultItem {
  success: boolean;
  id?: string;
  error?: string;
}

async function bulkCreateTransactionsTool(db: Database.Database, args: BulkCreateTransactionsArgs): Promise<unknown> {
  const sorted = [...args.transactions].sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0
  );

  const results: BulkCreateResultItem[] = [];
  let created = 0;
  let failed = 0;

  // Sequential, not parallel — the envelope must apply transactions in
  // datetime order for rebalance-after-big-purchase and week/month
  // boundaries to compute correctly.
  for (const txn of sorted) {
    try {
      const result = (await createTransactionTool(db, txn)) as { transaction: Transaction };
      results.push({ success: true, id: result.transaction.id });
      created++;
    } catch (err) {
      results.push({ success: false, error: err instanceof Error ? err.message : String(err) });
      failed++;
    }
  }

  return { created, failed, results, envelope: getEnvelopeState(db) };
}

// -- delete_transaction --

function deleteTransactionTool(db: Database.Database, args: { id: string }): unknown {
  const existing = getTransaction(db, args.id);
  if (!existing) return { error: `transaction ${args.id} not found` };

  let envelopeReversed = false;
  if (existing.envelope_applied) {
    const magnitude = existing.envelope_impact ?? existing.amount ?? 0;
    const envelope = getEnvelope(db);
    if (envelope) {
      updateEnvelope(db, {
        current_week_spent: (envelope.current_week_spent ?? 0) - magnitude,
        spent_discretionary: (envelope.spent_discretionary ?? 0) - magnitude,
      });
      envelopeReversed = true;
    }
  }

  if (existing.split_id) {
    deleteSplit(db, existing.split_id);
  }

  deleteTransaction(db, args.id);

  return { deleted: true, envelope_reversed: envelopeReversed };
}

// -- reconcile_envelope --

function reconcileEnvelopeTool(db: Database.Database): unknown {
  return reconcileEnvelopeFromTransactions(db);
}

// -- list_context --

const INTERNAL_CONTEXT_KEYS = new Set(["telegram_message_map", "processed_message_ids"]);

function listContextTool(db: Database.Database): unknown {
  const rows = listContext(db);
  const result: Record<string, string | null> = {};
  for (const row of rows) {
    if (INTERNAL_CONTEXT_KEYS.has(row.key)) continue;
    result[row.key] = row.value;
  }
  return result;
}

// -- delete_committed_expense --

function deleteCommittedExpenseTool(db: Database.Database, args: { id: string }): unknown {
  const existing = getCommittedExpense(db, args.id);
  if (!existing) return { error: `committed expense ${args.id} not found` };

  deleteCommittedExpense(db, args.id);
  const envelope = recalculateEnvelope(db);

  return { deleted: true, envelope };
}

// -- tool registry --

export const tools: ToolDefinition[] = [
  ...v2Tools,
  {
    name: "get_envelope",
    description: "Get the full current envelope state, including week/month progress as percentages.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => getEnvelopeTool(db),
  },
  {
    name: "get_transactions",
    description:
      "Get filtered transactions, sorted newest first. Use to look up recent spending, a specific merchant, or a date range.",
    parameters: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date, inclusive lower bound on transaction datetime" },
        until: { type: "string", description: "ISO date, inclusive upper bound on transaction datetime" },
        source: { type: "string", enum: ["idfc_cc", "bobcard", "amex", "idfc_upi"] },
        category: { type: "string" },
        min_amount: { type: "number" },
        limit: { type: "number", description: "Max rows to return, default 20" },
      },
      required: [],
    },
    handler: (db, args) => getTransactionsTool(db, args as GetTransactionsArgs),
  },
  {
    name: "update_transaction",
    description:
      "Correct any bank-parsed field on a transaction once the user has confirmed the correction: category, notes, committed flag, clean/raw merchant name, card last4, datetime (e.g. when the source email had no time-of-day, like AmEx), cancelled-out flag, the amount itself, or resolve a pending international transaction's INR amount. Changing amount or amount_inr automatically reverses the old envelope deduction and re-applies the corrected one. Always confirm the correction with the user before calling this.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        category: { type: "string" },
        notes: { type: "string" },
        is_committed: { type: "boolean" },
        merchant_clean: { type: "string" },
        merchant_raw: { type: "string" },
        card_last4: { type: "string" },
        datetime: { type: "string", description: "ISO 8601 datetime to correct an inaccurate or missing timestamp" },
        is_cancelled_out: { type: "boolean" },
        amount: { type: "number", description: "Corrected transaction amount, if the parsed amount was wrong" },
        amount_inr: { type: "number", description: "INR value for a resolved international transaction" },
      },
      required: ["id"],
    },
    handler: (db, args) => updateTransactionTool(db, args as unknown as UpdateTransactionArgs),
  },
  {
    name: "mark_as_split",
    description:
      "Mark a transaction as a group expense split with other people. Adjusts the transaction's envelope impact down to your_share and re-applies it to the envelope.",
    parameters: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        your_share: { type: "number", description: "Your portion of the total amount" },
        paid_by_you: { type: "boolean", description: "Whether you fronted the full payment" },
        people: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              amount: { type: "number" },
            },
            required: ["name", "amount"],
          },
        },
      },
      required: ["transaction_id", "your_share", "paid_by_you", "people"],
    },
    handler: (db, args) => markAsSplitTool(db, args as unknown as MarkAsSplitArgs),
  },
  {
    name: "settle_split",
    description: "Mark a split as settled once the owed money has been received. Does not affect the envelope.",
    parameters: {
      type: "object",
      properties: { split_id: { type: "string" } },
      required: ["split_id"],
    },
    handler: (db, args) => settleSplitTool(db, args as { split_id: string }),
  },
  {
    name: "set_committed_expense",
    description:
      "Add a new recurring committed expense (e.g. rent, subscriptions, househelp). Recalculates the envelope's committed total and discretionary pool.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        merchant_pattern: { type: "string" },
        vpa: { type: "string" },
        amount_approx: { type: "number" },
      },
      required: ["label", "amount_approx"],
    },
    handler: (db, args) => setCommittedExpenseTool(db, args as unknown as SetCommittedExpenseArgs),
  },
  {
    name: "recalculate_envelope",
    description:
      "Recompute committed_total, discretionary_pool, and current_week_budget from the current committed expenses list, without resetting spent-so-far tracking. Use after adding or removing a committed expense mid-month.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => recalculateEnvelopeTool(db),
  },
  {
    name: "get_summary",
    description:
      "Legacy raw calendar activity summary in INR. It is not true personal spend and does not model salary funding months; use get_funding_summary for recommendations.",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["week", "month"] },
      },
      required: ["period"],
    },
    handler: (db, args) => getSummaryTool(db, args as unknown as GetSummaryArgs),
  },
  {
    name: "get_splits_owed",
    description: "Get all unsettled splits where you paid, grouped by person with total owed per person.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => getSplitsOwedTool(db),
  },
  {
    name: "set_context",
    description:
      "Persist a learned fact or user decision for future reference (e.g. a VPA, a preferred label, a trip budget plan). Call this after every meaningful learned fact.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
    handler: (db, args) => setContextTool(db, args as { key: string; value: string }),
  },
  {
    name: "get_context",
    description: "Read a single persisted context value by key.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    handler: (db, args) => getContextTool(db, args as { key: string }),
  },
  {
    name: "get_card_billing_window",
    description:
      "Get the current billing cycle window (start/end dates) and due day for a credit card. All cycles cross a month boundary. Use this before deciding whether a payment is a bill settlement.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["idfc_cc", "bobcard", "amex"] },
      },
      required: ["source"],
    },
    handler: (db, args) => getCardBillingWindowTool(db, args as { source: string }),
  },
  {
    name: "create_transaction",
    description:
      "Create a new transaction manually for backfilling historical statement data. Pass merchant_clean and category directly to skip GPT enrichment.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["idfc_cc", "bobcard", "amex", "idfc_upi"] },
        amount: { type: "number" },
        merchant_raw: { type: "string" },
        merchant_clean: { type: "string", description: "If provided along with category, enrichment is skipped" },
        category: { type: "string", description: "If provided along with merchant_clean, enrichment is skipped" },
        datetime: { type: "string", description: "ISO 8601 datetime" },
        card_last4: { type: "string" },
        currency: { type: "string", description: "Default INR" },
        amount_inr: { type: "number", description: "INR value for an international transaction" },
        is_committed: { type: "boolean", description: "Default false" },
        is_cancelled_out: { type: "boolean", description: "Default false" },
        is_reversal: { type: "boolean", description: "Default false" },
        is_international: { type: "boolean", description: "Default false" },
        envelope_impact: { type: "number", description: "Override amount for envelope purposes, e.g. a split/partial charge" },
        notes: { type: "string" },
      },
      required: ["source", "amount", "merchant_raw", "datetime"],
    },
    handler: (db, args) => createTransactionTool(db, args as unknown as CreateTransactionArgs),
  },
  {
    name: "bulk_create_transactions",
    description:
      "Create multiple transactions in one call for statement backfill. Applied sequentially in datetime order (not parallel), so the envelope's rebalance and week/month math stays correct. A failure on one row doesn't abort the rest.",
    parameters: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", enum: ["idfc_cc", "bobcard", "amex", "idfc_upi"] },
              amount: { type: "number" },
              merchant_raw: { type: "string" },
              merchant_clean: { type: "string" },
              category: { type: "string" },
              datetime: { type: "string" },
              card_last4: { type: "string" },
              currency: { type: "string" },
              amount_inr: { type: "number" },
              is_committed: { type: "boolean" },
              is_cancelled_out: { type: "boolean" },
              is_reversal: { type: "boolean" },
              is_international: { type: "boolean" },
              envelope_impact: { type: "number" },
              notes: { type: "string" },
            },
            required: ["source", "amount", "merchant_raw", "datetime"],
          },
        },
      },
      required: ["transactions"],
    },
    handler: (db, args) => bulkCreateTransactionsTool(db, args as unknown as BulkCreateTransactionsArgs),
  },
  {
    name: "delete_transaction",
    description:
      "Delete a transaction and reverse its envelope impact if it had been applied. Use to correct backfill mistakes. Also deletes any associated split.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: (db, args) => deleteTransactionTool(db, args as { id: string }),
  },
  {
    name: "reconcile_envelope",
    description:
      "Recompute spent_discretionary and current_week_spent from scratch by re-summing actual transaction data (envelope_impact of non-committed, non-cancelled, applied transactions), then re-derive current_week_budget from what's left. Use after a bulk backfill or a batch of manual create/delete_transaction calls, where incremental tracking may have drifted from the real transaction data. Distinct from recalculate_envelope, which only rederives the committed total and discretionary pool from committed expenses and assumes spend tracking is already accurate.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => reconcileEnvelopeTool(db),
  },
  {
    name: "list_context",
    description: "Return all persisted context key-value pairs as a single object, excluding internal plumbing keys.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => listContextTool(db),
  },
  {
    name: "delete_committed_expense",
    description:
      "Remove a committed expense entry and recalculate the envelope's committed total and discretionary pool.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: (db, args) => deleteCommittedExpenseTool(db, args as { id: string }),
  },
];
