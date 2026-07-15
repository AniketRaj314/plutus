import type Database from "better-sqlite3";
import { getCreditCard } from "../db/queries";
import {
  aggregateSpendMonth,
  aggregateEnvelopeEntries,
  createCommitment,
  createEnvelopeEntry,
  createReceivable,
  getActiveSalaryProfile,
  getRawTransaction,
  insertRawTransaction,
  listCommitments,
  listContextFacts,
  listEnvelopeEntries,
  listReceivables,
  listRawTransactions,
  listUninterpretedTransactions,
  recordConfirmedCreditAllocation,
  setContextFact,
  updateCommitment,
  updateReceivable,
  updateSalaryProfile,
  type CommitmentStatus,
  type ContextScope,
  type EnvelopeEntryState,
  type LedgerGroupBy,
  type ReceivableStatus,
  type TransactionDirection,
} from "../db/v2-queries";
import { getCardCycleForDate } from "../envelope/engine";
import { inferRawTransaction, processInferenceQueue } from "./inference";

interface V2ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (db: Database.Database, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const CARD_SOURCES = ["amex", "bobcard", "idfc_cc"];
const ALL_SOURCES = [...CARD_SOURCES, "idfc_upi"];
const ENTRY_STATES: EnvelopeEntryState[] = ["forecast", "actual", "settled", "cancelled"];
const CONTEXT_SCOPES: ContextScope[] = ["global", "merchant", "transaction", "card", "person"];
const RECEIVABLE_STATES: ReceivableStatus[] = ["pending", "partial", "received", "written_off"];
const COMMITMENT_STATES: CommitmentStatus[] = ["active", "paused", "completed", "cancelled"];
const TRANSACTION_DIRECTIONS: TransactionDirection[] = ["debit", "credit"];

function resolvedInrAmount(transaction: NonNullable<ReturnType<typeof getRawTransaction>>): number {
  if (transaction.is_international) return transaction.amount_inr ?? 0;
  return transaction.amount ?? 0;
}

function createEntryHandler(db: Database.Database, args: Record<string, unknown>): unknown {
  const rawId = args.raw_transaction_id as string | undefined;
  const raw = rawId ? getRawTransaction(db, rawId) : undefined;
  if (rawId && !raw) throw new Error(`transaction ${rawId} not found`);

  return createEnvelopeEntry(db, {
    raw_transaction_id: rawId,
    funding_month: args.funding_month as string,
    occurred_at: (args.occurred_at as string | undefined) ?? raw?.occurred_at ?? undefined,
    source: (args.source as string | undefined) ?? raw?.source ?? undefined,
    card_cycle_start: args.card_cycle_start as string | undefined,
    card_cycle_end: args.card_cycle_end as string | undefined,
    due_date: args.due_date as string | undefined,
    merchant_clean:
      (args.merchant_clean as string | undefined) ?? raw?.merchant_raw ?? undefined,
    category: args.category as string | undefined,
    treatment: args.treatment as string,
    state: args.state as EnvelopeEntryState | undefined,
    gross_amount_inr:
      (args.gross_amount_inr as number | undefined) ?? (raw ? resolvedInrAmount(raw) : undefined),
    personal_impact: args.personal_impact as number | undefined,
    cashflow_impact: args.cashflow_impact as number | undefined,
    receivable_amount: args.receivable_amount as number | undefined,
    notes: args.notes as string | undefined,
    confidence: args.confidence as number | undefined,
    created_by: args.created_by as string,
    supersedes_id: args.supersedes_id as string | undefined,
  });
}

export const v2Tools: V2ToolDefinition[] = [
  {
    name: "create_raw_transaction",
    description:
      "Store one immutable bank/card fact without applying financial meaning. Duplicate raw_email_id values are idempotent.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional caller-provided id for linkage" },
        source: { type: "string", enum: ALL_SOURCES },
        amount: { type: "number" },
        currency: { type: "string" },
        amount_inr: { type: "number" },
        merchant_raw: { type: "string" },
        occurred_at: { type: "string" },
        card_last4: { type: "string" },
        is_reversal: { type: "boolean" },
        is_international: { type: "boolean" },
        is_preauth: { type: "boolean" },
        direction: { type: "string", enum: TRANSACTION_DIRECTIONS },
        raw_email_id: { type: "string" },
        raw_payload: { type: "string" },
      },
      required: ["source", "amount", "occurred_at"],
    },
    handler: (db, args) =>
      insertRawTransaction(db, {
        id: args.id as string | undefined,
        source: args.source as string,
        amount: args.amount as number,
        currency: args.currency as string | undefined,
        amount_inr: args.amount_inr as number | undefined,
        merchant_raw: args.merchant_raw as string | undefined,
        occurred_at: args.occurred_at as string,
        card_last4: args.card_last4 as string | undefined,
        is_reversal: args.is_reversal as boolean | undefined,
        is_international: args.is_international as boolean | undefined,
        is_preauth: args.is_preauth as boolean | undefined,
        direction: args.direction as TransactionDirection | undefined,
        raw_email_id: args.raw_email_id as string | undefined,
        raw_payload: args.raw_payload as string | undefined,
      }),
  },
  {
    name: "bulk_create_raw_transactions",
    description:
      "Store immutable raw statement facts in one call. Rows are independent; one failure does not abort the rest and no envelope logic runs.",
    parameters: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              source: { type: "string", enum: ALL_SOURCES },
              amount: { type: "number" },
              currency: { type: "string" },
              amount_inr: { type: "number" },
              merchant_raw: { type: "string" },
              occurred_at: { type: "string" },
              card_last4: { type: "string" },
              is_reversal: { type: "boolean" },
              is_international: { type: "boolean" },
              is_preauth: { type: "boolean" },
              direction: { type: "string", enum: TRANSACTION_DIRECTIONS },
              raw_email_id: { type: "string" },
              raw_payload: { type: "string" },
            },
            required: ["source", "amount", "occurred_at"],
          },
        },
      },
      required: ["transactions"],
    },
    handler: (db, args) => {
      const rows = args.transactions as Array<Record<string, unknown>>;
      const results: Array<{ success: boolean; id?: string; error?: string }> = [];
      for (const row of rows) {
        try {
          const created = insertRawTransaction(db, {
            id: row.id as string | undefined,
            source: row.source as string,
            amount: row.amount as number,
            currency: row.currency as string | undefined,
            amount_inr: row.amount_inr as number | undefined,
            merchant_raw: row.merchant_raw as string | undefined,
            occurred_at: row.occurred_at as string,
            card_last4: row.card_last4 as string | undefined,
            is_reversal: row.is_reversal as boolean | undefined,
            is_international: row.is_international as boolean | undefined,
            is_preauth: row.is_preauth as boolean | undefined,
            direction: row.direction as TransactionDirection | undefined,
            raw_email_id: row.raw_email_id as string | undefined,
            raw_payload: row.raw_payload as string | undefined,
          });
          results.push({ success: true, id: created.id });
        } catch (error) {
          results.push({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        created: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
        results,
      };
    },
  },
  {
    name: "get_raw_transactions",
    description: "Read immutable bank/card evidence without financial interpretation.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ALL_SOURCES },
        direction: { type: "string", enum: TRANSACTION_DIRECTIONS },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
    handler: (db, args) =>
      listRawTransactions(db, {
        source: args.source as string | undefined,
        direction: args.direction as TransactionDirection | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_salary_profile",
    description: "Get the active salary funding profile and monthly INR limit.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: (db) => getActiveSalaryProfile(db) ?? { error: "no active salary profile" },
  },
  {
    name: "update_salary_profile",
    description: "Update mechanical salary configuration such as salary day or monthly limit.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Profile id; default profile is 'default'" },
        label: { type: "string" },
        salary_day: { type: "number" },
        monthly_limit_inr: { type: "number" },
        is_active: { type: "boolean" },
      },
      required: ["id"],
    },
    handler: (db, args) =>
      updateSalaryProfile(db, args.id as string, {
        label: args.label as string | undefined,
        salary_day: args.salary_day as number | undefined,
        monthly_limit_inr: args.monthly_limit_inr as number | undefined,
        is_active: args.is_active as boolean | undefined,
      }) ?? { error: `salary profile ${String(args.id)} not found` },
  },
  {
    name: "get_card_cycle_for_date",
    description:
      "Mechanically map a card transaction date to its configured billing cycle, due date, and salary funding month. This does not infer financial treatment.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: CARD_SOURCES },
        datetime: { type: "string", description: "ISO 8601 transaction datetime" },
      },
      required: ["source", "datetime"],
    },
    handler: (db, args) => {
      const card = getCreditCard(db, args.source as string);
      if (!card) return { error: `unknown card source ${String(args.source)}` };
      const date = new Date(args.datetime as string);
      if (Number.isNaN(date.getTime())) throw new Error("datetime must be valid ISO 8601");
      return { card, ...getCardCycleForDate(card, date) };
    },
  },
  {
    name: "list_uninterpreted_transactions",
    description:
      "List raw transactions that do not yet have an active v2 envelope entry. Use this as the interpretation work queue.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ALL_SOURCES },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
    handler: (db, args) =>
      listUninterpretedTransactions(db, {
        source: args.source as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "infer_raw_transaction",
    description:
      "Ask Plutus's AI inference worker to interpret one raw transaction and persist its clean v2 entry, or return the context question that blocks interpretation.",
    parameters: {
      type: "object",
      properties: {
        raw_transaction_id: { type: "string" },
        min_confidence: { type: "number" },
      },
      required: ["raw_transaction_id"],
    },
    handler: (db, args) =>
      inferRawTransaction(db, args.raw_transaction_id as string, {
        minConfidence: args.min_confidence as number | undefined,
      }),
  },
  {
    name: "interpret_pending_transactions",
    description:
      "Process a bounded batch of uninterpreted raw transactions through Plutus's AI worker. Ambiguous rows remain pending with a persisted question.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum queue rows to inspect; defaults to 10" },
        min_confidence: { type: "number" },
      },
      required: [],
    },
    handler: (db, args) =>
      processInferenceQueue(db, {
        limit: args.limit as number | undefined,
        minConfidence: args.min_confidence as number | undefined,
      }),
  },
  {
    name: "create_envelope_entry",
    description:
      "Persist an AI/user interpretation in the clean v2 ledger. personal_impact affects the ₹1.2L salary envelope; cashflow_impact represents temporary cash required. Raw evidence is never modified.",
    parameters: {
      type: "object",
      properties: {
        raw_transaction_id: { type: "string" },
        funding_month: { type: "string", description: "Salary funding month in YYYY-MM" },
        occurred_at: { type: "string" },
        source: { type: "string", enum: ALL_SOURCES },
        card_cycle_start: { type: "string" },
        card_cycle_end: { type: "string" },
        due_date: { type: "string" },
        merchant_clean: { type: "string" },
        category: { type: "string" },
        treatment: {
          type: "string",
          description: "Semantic label such as normal, committed, reimbursable, split, financed_principal, emi, refund, settlement, ignored, or bookkeeping",
        },
        state: { type: "string", enum: ENTRY_STATES },
        gross_amount_inr: { type: "number" },
        personal_impact: { type: "number" },
        cashflow_impact: { type: "number" },
        receivable_amount: { type: "number" },
        notes: { type: "string" },
        confidence: { type: "number" },
        created_by: { type: "string", description: "Agent/user provenance, e.g. codex, claude, telegram_user" },
        supersedes_id: { type: "string", description: "Existing entry replaced by this corrected interpretation" },
      },
      required: ["funding_month", "treatment", "personal_impact", "cashflow_impact", "created_by"],
    },
    handler: createEntryHandler,
  },
  {
    name: "list_envelope_entries",
    description: "Read clean, active v2 ledger entries with optional salary-month and treatment filters.",
    parameters: {
      type: "object",
      properties: {
        funding_month: { type: "string" },
        source: { type: "string", enum: ALL_SOURCES },
        state: { type: "string", enum: ENTRY_STATES },
        treatment: { type: "string" },
        raw_transaction_id: { type: "string" },
        include_superseded: { type: "boolean" },
        limit: { type: "number" },
      },
      required: [],
    },
    handler: (db, args) =>
      listEnvelopeEntries(db, {
        funding_month: args.funding_month as string | undefined,
        source: args.source as string | undefined,
        state: args.state as EnvelopeEntryState | undefined,
        treatment: args.treatment as string | undefined,
        raw_transaction_id: args.raw_transaction_id as string | undefined,
        include_superseded: args.include_superseded as boolean | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_spend_month_summary",
    description:
      "Canonical tool for questions like 'how much did I spend in July?'. Card entries are selected by card-cycle end month; IDFC savings/UPI entries are selected by IST occurrence month. Returns actual, forecast, expected personal impact, the ₹1.2L limit, and remaining budget. Use get_funding_summary instead only for salary-settlement or cash-funding questions.",
    parameters: {
      type: "object",
      properties: {
        spend_month: { type: "string", description: "Spending envelope month in YYYY-MM" },
        group_by: { type: "string", enum: ["source", "category", "treatment", "state"] },
      },
      required: ["spend_month"],
    },
    handler: (db, args) =>
      aggregateSpendMonth(db, {
        spend_month: args.spend_month as string,
        group_by: args.group_by as LedgerGroupBy | undefined,
      }),
  },
  {
    name: "get_funding_summary",
    description:
      "Return deterministic sums of gross activity, personal impact, cash-flow impact, and receivables for a salary funding month. The backend only aggregates stored interpretations.",
    parameters: {
      type: "object",
      properties: {
        funding_month: { type: "string" },
        source: { type: "string", enum: ALL_SOURCES },
        group_by: { type: "string", enum: ["source", "category", "treatment", "state"] },
      },
      required: ["funding_month"],
    },
    handler: (db, args) =>
      aggregateEnvelopeEntries(db, {
        funding_month: args.funding_month as string,
        source: args.source as string | undefined,
        group_by: args.group_by as LedgerGroupBy | undefined,
      }),
  },
  {
    name: "set_context_fact",
    description:
      "Persist a scoped fact shared across every agent. Replaces the previous active value for the same scope/key while retaining history.",
    parameters: {
      type: "object",
      properties: {
        scope_type: { type: "string", enum: CONTEXT_SCOPES },
        scope_id: { type: "string", description: "Empty for global scope; merchant/card/person/transaction identifier otherwise" },
        key: { type: "string" },
        value: { type: "string" },
        source: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["scope_type", "key", "value", "source"],
    },
    handler: (db, args) =>
      setContextFact(db, {
        scope_type: args.scope_type as ContextScope,
        scope_id: args.scope_id as string | undefined,
        key: args.key as string,
        value: args.value as string,
        source: args.source as string,
        confidence: args.confidence as number | undefined,
      }),
  },
  {
    name: "list_context_facts",
    description: "Read active scoped facts shared by Telegram, Claude, OpenAI, and other MCP clients.",
    parameters: {
      type: "object",
      properties: {
        scope_type: { type: "string", enum: CONTEXT_SCOPES },
        scope_id: { type: "string" },
        key: { type: "string" },
        include_superseded: { type: "boolean" },
      },
      required: [],
    },
    handler: (db, args) =>
      listContextFacts(db, {
        scope_type: args.scope_type as ContextScope | undefined,
        scope_id: args.scope_id as string | undefined,
        key: args.key as string | undefined,
        include_superseded: args.include_superseded as boolean | undefined,
      }),
  },
  {
    name: "create_receivable",
    description: "Record money owed back to the user for an employer reimbursement or personal split.",
    parameters: {
      type: "object",
      properties: {
        envelope_entry_id: { type: "string" },
        counterparty: { type: "string" },
        label: { type: "string" },
        amount_inr: { type: "number" },
        received_inr: { type: "number" },
        expected_at: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string" },
      },
      required: ["counterparty", "label", "amount_inr", "created_by"],
    },
    handler: (db, args) =>
      createReceivable(db, {
        envelope_entry_id: args.envelope_entry_id as string | undefined,
        counterparty: args.counterparty as string,
        label: args.label as string,
        amount_inr: args.amount_inr as number,
        received_inr: args.received_inr as number | undefined,
        expected_at: args.expected_at as string | undefined,
        notes: args.notes as string | undefined,
        created_by: args.created_by as string,
      }),
  },
  {
    name: "update_receivable",
    description: "Record partial/full receipt, write-off, expected date, or notes for money owed back.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        received_inr: { type: "number" },
        status: { type: "string", enum: RECEIVABLE_STATES },
        expected_at: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    handler: (db, args) =>
      updateReceivable(db, args.id as string, {
        received_inr: args.received_inr as number | undefined,
        status: args.status as ReceivableStatus | undefined,
        expected_at: args.expected_at as string | null | undefined,
        notes: args.notes as string | null | undefined,
      }) ?? { error: `receivable ${String(args.id)} not found` },
  },
  {
    name: "list_receivables",
    description: "List pending or historical reimbursements and split debts.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: RECEIVABLE_STATES },
        counterparty: { type: "string" },
        include_closed: { type: "boolean" },
      },
      required: [],
    },
    handler: (db, args) =>
      listReceivables(db, {
        status: args.status as ReceivableStatus | undefined,
        counterparty: args.counterparty as string | undefined,
        include_closed: args.include_closed as boolean | undefined,
      }),
  },
  {
    name: "record_confirmed_credit_allocation",
    description:
      "After the user explicitly confirms how an incoming credit should be understood, atomically allocate it, update any referenced receivables, store a zero/nonzero personal impact chosen by the agent, and retain the allocation as shared transaction context. Never call before confirmation.",
    parameters: {
      type: "object",
      properties: {
        raw_transaction_id: { type: "string" },
        allocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              receivable_id: { type: ["string", "null"] },
              kind: {
                type: "string",
                description: "Agent-chosen semantic label such as receivable_settlement or unallocated_surplus",
              },
              amount_inr: { type: "number" },
              notes: { type: ["string", "null"] },
            },
            required: ["kind", "amount_inr"],
          },
        },
        treatment: { type: "string" },
        personal_impact: { type: "number" },
        cashflow_impact: { type: "number" },
        category: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string" },
      },
      required: [
        "raw_transaction_id",
        "allocations",
        "treatment",
        "personal_impact",
        "cashflow_impact",
        "created_by",
      ],
    },
    handler: (db, args) =>
      recordConfirmedCreditAllocation(db, {
        raw_transaction_id: args.raw_transaction_id as string,
        allocations: args.allocations as Array<{
          receivable_id?: string | null;
          kind: string;
          amount_inr: number;
          notes?: string | null;
        }>,
        treatment: args.treatment as string,
        personal_impact: args.personal_impact as number,
        cashflow_impact: args.cashflow_impact as number,
        category: args.category as string | undefined,
        notes: args.notes as string | undefined,
        created_by: args.created_by as string,
      }),
  },
  {
    name: "create_commitment",
    description:
      "Store a recurring or fixed obligation as shared agent context. Forecast envelope entries are created separately so actual charges can replace them explicitly.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        amount_inr: { type: "number" },
        frequency: { type: "string" },
        start_funding_month: { type: "string" },
        end_funding_month: { type: "string" },
        remaining_occurrences: { type: "number" },
        merchant_pattern: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string" },
      },
      required: ["label", "amount_inr", "start_funding_month", "created_by"],
    },
    handler: (db, args) =>
      createCommitment(db, {
        label: args.label as string,
        amount_inr: args.amount_inr as number,
        frequency: args.frequency as string | undefined,
        start_funding_month: args.start_funding_month as string,
        end_funding_month: args.end_funding_month as string | undefined,
        remaining_occurrences: args.remaining_occurrences as number | undefined,
        merchant_pattern: args.merchant_pattern as string | undefined,
        notes: args.notes as string | undefined,
        created_by: args.created_by as string,
      }),
  },
  {
    name: "update_commitment",
    description: "Update, pause, complete, or cancel a stored commitment without deleting its history.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        amount_inr: { type: "number" },
        end_funding_month: { type: ["string", "null"] },
        remaining_occurrences: { type: ["number", "null"] },
        status: { type: "string", enum: COMMITMENT_STATES },
        notes: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    handler: (db, args) =>
      updateCommitment(db, args.id as string, {
        amount_inr: args.amount_inr as number | undefined,
        end_funding_month: args.end_funding_month as string | null | undefined,
        remaining_occurrences: args.remaining_occurrences as number | null | undefined,
        status: args.status as CommitmentStatus | undefined,
        notes: args.notes as string | null | undefined,
      }) ?? { error: `commitment ${String(args.id)} not found` },
  },
  {
    name: "list_commitments_v2",
    description: "List active or historical v2 commitments, optionally for one salary funding month.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: COMMITMENT_STATES },
        funding_month: { type: "string" },
      },
      required: [],
    },
    handler: (db, args) =>
      listCommitments(db, {
        status: args.status as CommitmentStatus | undefined,
        funding_month: args.funding_month as string | undefined,
      }),
  },
];
