import type Database from "better-sqlite3";
import {
  getEnvelope,
  queryTransactions,
  getTransaction,
  updateTransaction,
  insertSplit,
  updateSplit,
  listAllSplits,
  insertCommittedExpense,
  listTransactions,
  setContext,
  getContext,
  getCreditCard,
  updateEnvelope,
  type Transaction,
  type NewTransaction,
} from "../db/queries";
import { applyTransaction, recalculateEnvelope, getEnvelopeState, getBillingWindow } from "../envelope/engine";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (db: Database.Database, args: Record<string, unknown>) => unknown;
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

  for (const t of inPeriod) {
    const amount = t.amount ?? 0;
    const signed = t.is_reversal ? -amount : amount;
    totalSpent += signed;

    const category = t.category ?? "Uncategorized";
    byCategory[category] = (byCategory[category] ?? 0) + signed;

    const merchant = t.merchant_clean ?? t.merchant_raw ?? "Unknown";
    byMerchant[merchant] = (byMerchant[merchant] ?? 0) + signed;

    if (t.is_international && t.amount_inr === null) internationalPendingCount++;
  }

  return {
    total_spent: round2(totalSpent),
    by_category: Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({ category, amount: round2(amount) })),
    top_merchants: Object.entries(byMerchant)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([merchant, amount]) => ({ merchant, amount: round2(amount) })),
    envelope_state: envelope,
    transaction_count: inPeriod.length,
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

// -- tool registry --

export const tools: ToolDefinition[] = [
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
    description: "Get a spending summary for the current week or month: totals, by-category breakdown, top merchants.",
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
];
