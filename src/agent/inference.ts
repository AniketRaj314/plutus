import OpenAI from "openai";
import cron from "node-cron";
import type Database from "better-sqlite3";
import { getCreditCard, getTransaction } from "../db/queries";
import {
  createEnvelopeEntry,
  createReceivable,
  getActiveSalaryProfile,
  getRawTransaction,
  listCommitments,
  listContextFacts,
  listEnvelopeEntries,
  listReceivables,
  listUninterpretedTransactions,
  setContextFact,
  type EnvelopeEntry,
  type RawTransactionV2,
  type Receivable,
} from "../db/v2-queries";
import { getCardCycleForDate, getSalaryFundingMonthForDate, type CardCycle } from "../envelope/engine";
import { CATEGORIES } from "../enrichment/gpt";
import {
  configureScheduler,
  normalizeCronInterval,
  runSchedulerCycle,
} from "../scheduler/status";

const MODEL = process.env.INFERENCE_MODEL || "gpt-4o";
const DEFAULT_MIN_CONFIDENCE = 0.75;

export interface InferenceReceivableProposal {
  counterparty: string;
  label: string;
  amount_inr: number;
  expected_at: string | null;
  notes: string | null;
}

export interface InferenceCreditAllocationProposal {
  receivable_id: string | null;
  kind: string;
  amount_inr: number;
  notes: string | null;
}

export interface TransactionInferenceProposal {
  decision: "interpret" | "needs_context";
  merchant_clean: string | null;
  category: string | null;
  treatment: string | null;
  gross_amount_inr: number | null;
  personal_impact: number | null;
  cashflow_impact: number | null;
  receivable_amount: number | null;
  confidence: number;
  notes: string | null;
  question: string | null;
  receivable: InferenceReceivableProposal | null;
  credit_allocations: InferenceCreditAllocationProposal[];
}

export interface InferenceContext {
  raw: RawTransactionV2;
  enriched_transaction: {
    merchant_clean: string | null;
    category: string | null;
    notes: string | null;
    enrichment_confidence: number | null;
    correlation_status: string | null;
    correlated_with: string | null;
  } | null;
  funding_month: string;
  card_cycle: CardCycle | null;
  salary_profile: ReturnType<typeof getActiveSalaryProfile>;
  commitments: ReturnType<typeof listCommitments>;
  open_receivables: ReturnType<typeof listReceivables>;
  context_facts: ReturnType<typeof listContextFacts>;
  recent_interpretations: EnvelopeEntry[];
}

export interface InferenceOutcome {
  status: "already_interpreted" | "interpreted" | "needs_context" | "failed";
  raw_transaction_id: string;
  entry?: EnvelopeEntry;
  receivable?: Receivable;
  question?: string;
  error?: string;
}

export type InferenceGenerator = (context: InferenceContext) => Promise<TransactionInferenceProposal>;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    client = new OpenAI({ apiKey });
  }
  return client;
}

function resolvedInrAmount(raw: RawTransactionV2): number | null {
  if (raw.is_international) return raw.amount_inr;
  return raw.amount;
}

function getMinConfidence(): number {
  const configured = Number(process.env.AUTO_INFERENCE_MIN_CONFIDENCE);
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : DEFAULT_MIN_CONFIDENCE;
}

export function isAutoInferenceEnabled(): boolean {
  return process.env.AUTO_INFERENCE_ENABLED !== "false";
}

function buildInferenceContext(db: Database.Database, raw: RawTransactionV2): InferenceContext {
  const occurredAt = new Date(raw.occurred_at);
  const salaryProfile = getActiveSalaryProfile(db);
  const card = getCreditCard(db, raw.source);
  const cardCycle = card ? getCardCycleForDate(card, occurredAt) : null;
  const fundingMonth = cardCycle
    ? cardCycle.funding_month
    : getSalaryFundingMonthForDate(occurredAt, salaryProfile?.salary_day ?? 1);
  const enriched = getTransaction(db, raw.id);

  return {
    raw,
    enriched_transaction: enriched
      ? {
          merchant_clean: enriched.merchant_clean,
          category: enriched.category,
          notes: enriched.notes,
          enrichment_confidence: enriched.enrichment_confidence,
          correlation_status: enriched.correlation_status,
          correlated_with: enriched.correlated_with,
        }
      : null,
    funding_month: fundingMonth,
    card_cycle: cardCycle,
    salary_profile: salaryProfile,
    commitments: listCommitments(db, { status: "active", funding_month: fundingMonth }),
    open_receivables: listReceivables(db),
    context_facts: listContextFacts(db)
      .filter((fact) => fact.key !== "automatic_inference")
      .slice(0, 150),
    recent_interpretations: listEnvelopeEntries(db, { limit: 30 }),
  };
}

const SYSTEM_PROMPT = `You interpret one immutable bank/card transaction for a personal finance ledger.

Financial judgment belongs to you, not to backend rules. Use only the supplied evidence and persisted context. Return strict JSON.

Definitions:
- gross_amount_inr: INR value visible in this event. It is normally positive even for a refund.
- personal_impact: true signed cost against the salary funding month's limit. A refund of personal spend is negative.
- cashflow_impact: signed temporary cash required by this event. A reimbursable charge is positive even when personal impact is zero.
- receivable_amount: new non-negative amount expected back because of this event.
- treatment: a concise semantic label such as normal, committed, reimbursable, split, financed_principal, emi, refund, settlement, ignored, or bookkeeping.

Important rules:
- Credit-card bill payments and transfers between the user's own accounts are bookkeeping, not new personal spend.
- A pre-authorization is provisional evidence, not finalized spend; normally record it with zero immediate impact unless supplied context proves it settled.
- Employer reimbursements and amounts paid for another person normally have personal_impact=0, cashflow_impact=gross, and a receivable.
- Do not charge an entire financed purchase to one month when context establishes an EMI. Interpret only the relevant actual EMI; leave the financed principal visible with zero immediate impact.
- Commitments are context, not automatic spend. This transaction is an actual event.
- If context is insufficient to distinguish materially different financial treatments, choose needs_context and ask one short specific question.
- Never invent a counterparty, reimbursement policy, split share, EMI amount, or settlement state.
- raw.direction is immutable evidence. For an incoming credit, reason whether it could be a receivable repayment, refund, salary, self-transfer, gift, surplus, or something else.
- If a credit plausibly settles open receivables, do not close them automatically. Return needs_context with a concise confirmation question and proposed credit_allocations covering the full credit.
- Matching is AI judgment: use counterparty text, amount, timing, open receivables, and context. Exact equality is not required; explicitly handle partial, combined, and surplus amounts.
- A proposed surplus may use a semantic kind such as unallocated_surplus with receivable_id=null. Repayments and confirmed surplus do not become personal spending or extra envelope allowance.

Return exactly:
{
  "decision": "interpret" | "needs_context",
  "merchant_clean": string | null,
  "category": string | null,
  "treatment": string | null,
  "gross_amount_inr": number | null,
  "personal_impact": number | null,
  "cashflow_impact": number | null,
  "receivable_amount": number | null,
  "confidence": number,
  "notes": string | null,
  "question": string | null,
  "receivable": null | {
    "counterparty": string,
    "label": string,
    "amount_inr": number,
    "expected_at": string | null,
    "notes": string | null
  },
  "credit_allocations": Array<{
    "receivable_id": string | null,
    "kind": string,
    "amount_inr": number,
    "notes": string | null
  }>
}

For debit events, credit_allocations must be []. For a proposed incoming-credit match, populate the proposed treatment and impact fields even though decision is needs_context; user confirmation is still required before persistence.

category, when non-null, must be one of: ${CATEGORIES.join(", ")}.`;

export async function generateInferenceWithOpenAI(
  context: InferenceContext
): Promise<TransactionInferenceProposal> {
  const openai = getClient();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(context) },
    ],
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("empty inference response from OpenAI");
  const parsed = parseInferenceResponse(raw);
  if (!parsed) throw new Error("invalid inference response from OpenAI");
  return parsed;
}

export function parseInferenceResponse(raw: string): TransactionInferenceProposal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.decision !== "interpret" && o.decision !== "needs_context") return null;
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) return null;

  const nullableStringKeys = ["merchant_clean", "category", "treatment", "notes", "question"] as const;
  for (const key of nullableStringKeys) {
    if (o[key] !== null && typeof o[key] !== "string") return null;
  }
  const nullableNumberKeys = [
    "gross_amount_inr",
    "personal_impact",
    "cashflow_impact",
    "receivable_amount",
  ] as const;
  for (const key of nullableNumberKeys) {
    if (o[key] !== null && (typeof o[key] !== "number" || !Number.isFinite(o[key]))) return null;
  }
  if (o.category !== null && !CATEGORIES.includes(o.category as (typeof CATEGORIES)[number])) return null;

  let receivable: InferenceReceivableProposal | null = null;
  if (o.receivable !== null) {
    if (typeof o.receivable !== "object" || o.receivable === null) return null;
    const r = o.receivable as Record<string, unknown>;
    if (typeof r.counterparty !== "string" || typeof r.label !== "string") return null;
    if (typeof r.amount_inr !== "number" || !Number.isFinite(r.amount_inr) || r.amount_inr < 0) return null;
    if (r.expected_at !== null && typeof r.expected_at !== "string") return null;
    if (r.notes !== null && typeof r.notes !== "string") return null;
    receivable = {
      counterparty: r.counterparty,
      label: r.label,
      amount_inr: r.amount_inr,
      expected_at: r.expected_at as string | null,
      notes: r.notes as string | null,
    };
  }

  const creditAllocationsRaw = o.credit_allocations ?? [];
  if (!Array.isArray(creditAllocationsRaw)) return null;
  const creditAllocations: InferenceCreditAllocationProposal[] = [];
  for (const item of creditAllocationsRaw) {
    if (typeof item !== "object" || item === null) return null;
    const allocation = item as Record<string, unknown>;
    if (allocation.receivable_id !== null && typeof allocation.receivable_id !== "string") return null;
    if (typeof allocation.kind !== "string" || !allocation.kind.trim()) return null;
    if (
      typeof allocation.amount_inr !== "number" ||
      !Number.isFinite(allocation.amount_inr) ||
      allocation.amount_inr <= 0
    ) {
      return null;
    }
    if (allocation.notes !== null && typeof allocation.notes !== "string") return null;
    creditAllocations.push({
      receivable_id: allocation.receivable_id as string | null,
      kind: allocation.kind,
      amount_inr: allocation.amount_inr,
      notes: allocation.notes as string | null,
    });
  }

  return {
    decision: o.decision,
    merchant_clean: o.merchant_clean as string | null,
    category: o.category as string | null,
    treatment: o.treatment as string | null,
    gross_amount_inr: o.gross_amount_inr as number | null,
    personal_impact: o.personal_impact as number | null,
    cashflow_impact: o.cashflow_impact as number | null,
    receivable_amount: o.receivable_amount as number | null,
    confidence: o.confidence,
    notes: o.notes as string | null,
    question: o.question as string | null,
    receivable,
    credit_allocations: creditAllocations,
  };
}

function recordInferenceState(
  db: Database.Database,
  rawTransactionId: string,
  state: { status: string; question?: string; error?: string; confidence?: number }
): void {
  const previous = getStoredInferenceState(db, rawTransactionId);
  const attempts = (previous?.attempts ?? 0) + (state.status === "completed" ? 0 : 1);
  setContextFact(db, {
    scope_type: "transaction",
    scope_id: rawTransactionId,
    key: "automatic_inference",
    value: JSON.stringify({ ...state, attempts }),
    source: "automatic_inference",
    confidence: state.confidence,
  });
}

export interface StoredInferenceState {
  status: string;
  question?: string;
  error?: string;
  confidence?: number;
  attempts: number;
}

export function getStoredInferenceState(
  db: Database.Database,
  rawTransactionId: string
): StoredInferenceState | undefined {
  const fact = listContextFacts(db, {
    scope_type: "transaction",
    scope_id: rawTransactionId,
    key: "automatic_inference",
  })[0];
  if (!fact) return undefined;
  try {
    const value = JSON.parse(fact.value) as Partial<StoredInferenceState>;
    if (typeof value.status !== "string") return undefined;
    return { ...value, status: value.status, attempts: Number(value.attempts) || 0 };
  } catch {
    return undefined;
  }
}

export async function inferRawTransaction(
  db: Database.Database,
  rawTransactionId: string,
  options: { generate?: InferenceGenerator; minConfidence?: number } = {}
): Promise<InferenceOutcome> {
  const active = listEnvelopeEntries(db, { raw_transaction_id: rawTransactionId, limit: 1 })[0];
  if (active) {
    return { status: "already_interpreted", raw_transaction_id: rawTransactionId, entry: active };
  }

  const raw = getRawTransaction(db, rawTransactionId);
  if (!raw) {
    return { status: "failed", raw_transaction_id: rawTransactionId, error: "raw transaction not found" };
  }

  if (raw.is_international && resolvedInrAmount(raw) === null) {
    const question = `What was the final INR amount for ${raw.currency} ${raw.amount} at ${raw.merchant_raw ?? "this merchant"}?`;
    recordInferenceState(db, raw.id, { status: "needs_context", question, confidence: 1 });
    return { status: "needs_context", raw_transaction_id: raw.id, question };
  }

  try {
    const context = buildInferenceContext(db, raw);
    const proposal = await (options.generate ?? generateInferenceWithOpenAI)(context);
    const minConfidence = options.minConfidence ?? getMinConfidence();

    if (proposal.decision === "needs_context" || proposal.confidence < minConfidence) {
      const question =
        proposal.question ??
        `How should ${raw.merchant_raw ?? "this transaction"} for ₹${resolvedInrAmount(raw) ?? raw.amount} be treated?`;
      if (raw.direction === "credit" && proposal.credit_allocations.length > 0) {
        setContextFact(db, {
          scope_type: "transaction",
          scope_id: raw.id,
          key: "credit_allocation",
          value: JSON.stringify({
            status: "proposed",
            question,
            allocations: proposal.credit_allocations,
            treatment: proposal.treatment,
            personal_impact: proposal.personal_impact,
            cashflow_impact: proposal.cashflow_impact,
            notes: proposal.notes,
          }),
          source: "automatic_inference",
          confidence: proposal.confidence,
        });
      }
      recordInferenceState(db, raw.id, {
        status: "needs_context",
        question,
        confidence: proposal.confidence,
      });
      return { status: "needs_context", raw_transaction_id: raw.id, question };
    }

    if (
      !proposal.treatment ||
      proposal.gross_amount_inr === null ||
      proposal.personal_impact === null ||
      proposal.cashflow_impact === null ||
      proposal.receivable_amount === null
    ) {
      throw new Error("interpreted proposal is missing required financial fields");
    }
    if (proposal.receivable_amount < 0) throw new Error("receivable_amount must be non-negative");
    if (proposal.receivable && proposal.receivable.amount_inr !== proposal.receivable_amount) {
      throw new Error("receivable detail amount must equal receivable_amount");
    }
    if (!proposal.receivable && proposal.receivable_amount !== 0) {
      throw new Error("receivable details are required when receivable_amount is non-zero");
    }
    const treatment = proposal.treatment;
    const grossAmountInr = proposal.gross_amount_inr;
    const personalImpact = proposal.personal_impact;
    const cashflowImpact = proposal.cashflow_impact;
    const receivableAmount = proposal.receivable_amount;

    const persisted = db.transaction(() => {
      const entry = createEnvelopeEntry(db, {
        raw_transaction_id: raw.id,
        funding_month: context.funding_month,
        occurred_at: raw.occurred_at,
        source: raw.source,
        card_cycle_start: context.card_cycle?.start,
        card_cycle_end: context.card_cycle?.end,
        due_date: context.card_cycle?.due_date,
        merchant_clean:
          proposal.merchant_clean ?? context.enriched_transaction?.merchant_clean ?? raw.merchant_raw ?? undefined,
        category: proposal.category ?? context.enriched_transaction?.category ?? undefined,
        treatment,
        state: "actual",
        gross_amount_inr: grossAmountInr,
        personal_impact: personalImpact,
        cashflow_impact: cashflowImpact,
        receivable_amount: receivableAmount,
        notes: proposal.notes ?? undefined,
        confidence: proposal.confidence,
        created_by: "automatic_inference",
      });
      const receivable = proposal.receivable
        ? createReceivable(db, {
            envelope_entry_id: entry.id,
            counterparty: proposal.receivable.counterparty,
            label: proposal.receivable.label,
            amount_inr: proposal.receivable.amount_inr,
            expected_at: proposal.receivable.expected_at ?? undefined,
            notes: proposal.receivable.notes ?? undefined,
            created_by: "automatic_inference",
          })
        : undefined;
      recordInferenceState(db, raw.id, {
        status: "completed",
        confidence: proposal.confidence,
      });
      return { entry, receivable };
    })();

    return {
      status: "interpreted",
      raw_transaction_id: raw.id,
      entry: persisted.entry,
      receivable: persisted.receivable,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordInferenceState(db, raw.id, { status: "failed", error: message });
    console.error(`[inference] failed for raw transaction ${raw.id}:`, error);
    return { status: "failed", raw_transaction_id: raw.id, error: message };
  }
}

const activeQueueDatabases = new WeakSet<Database.Database>();

export async function processInferenceQueue(
  db: Database.Database,
  options: { limit?: number; generate?: InferenceGenerator; minConfidence?: number } = {}
): Promise<InferenceOutcome[]> {
  if (activeQueueDatabases.has(db)) return [];
  activeQueueDatabases.add(db);
  try {
    const requestedLimit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    // Read past blocked/failed rows so an old clarification request cannot
    // starve newer transactions behind it in the chronological queue.
    const pending = listUninterpretedTransactions(db, { limit: 500 });
    const outcomes: InferenceOutcome[] = [];
    for (const raw of pending) {
      if (outcomes.length >= requestedLimit) break;
      const state = getStoredInferenceState(db, raw.id);
      if (state?.status === "needs_context" || (state?.status === "failed" && state.attempts >= 3)) continue;
      const legacy = getTransaction(db, raw.id);
      if (legacy?.correlation_status === "pending") continue;
      outcomes.push(
        await inferRawTransaction(db, raw.id, {
          generate: options.generate,
          minConfidence: options.minConfidence,
        })
      );
    }
    return outcomes;
  } finally {
    activeQueueDatabases.delete(db);
  }
}

export function startInferenceCron(db: Database.Database): void {
  const intervalMins = normalizeCronInterval(process.env.AUTO_INFERENCE_INTERVAL_MINS, 5);
  const enabled = isAutoInferenceEnabled();
  configureScheduler("automatic_inference", {
    label: "Automatic transaction inference",
    interval_minutes: intervalMins,
    enabled,
  });
  cron.schedule(`*/${intervalMins} * * * *`, () => {
    if (!enabled) return;
    void runSchedulerCycle("automatic_inference", async () => {
      await processInferenceQueue(db);
    });
  });
  console.log(
    `AI inference queue scheduled every ${intervalMins} minute(s)${enabled ? "" : " (disabled)"}`
  );
}
