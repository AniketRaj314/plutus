import cron from "node-cron";
import OpenAI from "openai";
import type Database from "better-sqlite3";
import { getGmailClient } from "../gmail/auth";
import {
  listPendingCorrelations,
  updateTransaction,
  getTransaction,
  type Transaction,
} from "../db/queries";
import { editMessage, getMessageIdForTransaction } from "../telegram/bot";
import { formatV2Transaction } from "../telegram/formatter";
import { getProcessedIds, saveProcessedIds } from "../gmail/poller";
import { CATEGORIES } from "./gpt";
import { aggregateSpendMonth, getSpendMonthForEntry } from "../db/v2-queries";
import {
  inferRawTransaction,
  isAutoInferenceEnabled,
  type InferenceOutcome,
} from "../agent/inference";
import { configureScheduler, runSchedulerCycle } from "../scheduler/status";

const CORRELATION_WINDOW_MS = 30 * 60 * 1000;
const GRACE_PERIOD_MS = 60 * 1000;
const SEARCH_LOOKBACK_MS = 10 * 60 * 1000;
const MATCH_CONFIDENCE_THRESHOLD = 0.8;

// Configurable, easy to extend as more merchants' receipt-sending
// addresses are confirmed.
export const MERCHANT_RECEIPT_SENDERS = [
  "noreply@uber.com",
  "receipts@uber.com",
  "noreply@zomato.com",
  "no-reply@zomato.com",
  "order@swiggy.in",
  "noreply@swiggy.com",
  "support@rapido.bike",
  "noreply@rapido.bike",
  "auto-confirm@amazon.in",
  "shipment-tracking@amazon.in",
  "noreply@blinkit.com",
  "hello@zepto.co",
];

export interface CandidateReceipt {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  datetime: string;
}

interface CorrelationResult {
  matched: boolean;
  matched_sender: string | null;
  merchant_clean: string | null;
  category: string | null;
  confidence: number;
  reasoning: string;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export function startCorrelator(db: Database.Database): void {
  configureScheduler("upi_correlation", {
    label: "UPI receipt correlator",
    interval_minutes: 5,
    enabled: true,
  });
  cron.schedule("*/5 * * * *", () => {
    void runSchedulerCycle("upi_correlation", () => checkPendingCorrelations(db));
  });
  console.log("UPI correlator scheduled every 5 minutes");
}

export async function checkPendingCorrelations(db: Database.Database): Promise<void> {
  const pending = listPendingCorrelations(db);
  const now = Date.now();

  const ready = pending.filter((t) => t.datetime && now - new Date(t.datetime).getTime() >= GRACE_PERIOD_MS);

  if (ready.length === 0) {
    console.log("[correlator] no pending transactions ready for a correlation attempt");
    return;
  }

  console.log(`[correlator] checking ${ready.length} pending transaction(s)`);

  for (const transaction of ready) {
    const ageMs = now - new Date(transaction.datetime as string).getTime();

    if (ageMs > CORRELATION_WINDOW_MS) {
      updateTransaction(db, transaction.id, { correlation_status: "unmatched" });
      const refreshed = getTransaction(db, transaction.id) ?? transaction;
      const inference = await inferAfterCorrelation(db, refreshed.id);
      await updateTelegramMessage(db, refreshed, inference);
      console.log(`[correlator] transaction ${transaction.id} window expired, marked unmatched`);
      continue;
    }

    try {
      await attemptCorrelation(db, transaction);
    } catch (err) {
      console.error(`[correlator] correlation attempt failed for transaction ${transaction.id}:`, err);
    }
  }
}

export async function attemptCorrelation(db: Database.Database, transaction: Transaction): Promise<void> {
  if (!transaction.datetime) return;

  const gmail = getGmailClient();
  const txTime = new Date(transaction.datetime).getTime();
  const afterEpoch = Math.floor((txTime - SEARCH_LOOKBACK_MS) / 1000);
  const beforeEpoch = Math.floor((txTime + CORRELATION_WINDOW_MS) / 1000);

  const query = `from:(${MERCHANT_RECEIPT_SENDERS.join(" OR ")}) after:${afterEpoch} before:${beforeEpoch}`;
  const listRes = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
  const messageIds = (listRes.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);

  if (messageIds.length === 0) {
    console.log(`[correlator] no candidate receipts found yet for transaction ${transaction.id}`);
    return;
  }

  const candidates: CandidateReceipt[] = [];
  for (const id of messageIds) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = msg.data.payload?.headers ?? [];
    const sender = headers.find((h) => h.name === "From")?.value ?? "";
    const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
    const dateHeader = headers.find((h) => h.name === "Date")?.value;
    const datetime = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

    candidates.push({ id, sender, subject, snippet: msg.data.snippet ?? "", datetime });
  }

  const result = await runCorrelationCheck(transaction, candidates);
  if (!result) return;

  if (result.matched && result.confidence >= MATCH_CONFIDENCE_THRESHOLD) {
    const matchedCandidate = candidates.find((c) => c.sender === result.matched_sender);

    updateTransaction(db, transaction.id, {
      merchant_clean: result.merchant_clean,
      category: result.category,
      correlated_with: matchedCandidate ? `${matchedCandidate.sender} @ ${matchedCandidate.datetime}` : result.matched_sender,
      correlation_status: "matched",
      notes: `correlated:${result.reasoning}`,
    });

    const finalTransaction = getTransaction(db, transaction.id) ?? transaction;
    const inference = await inferAfterCorrelation(db, finalTransaction.id);
    await updateTelegramMessage(db, finalTransaction, inference);

    if (matchedCandidate) {
      const processedIds = getProcessedIds(db);
      processedIds.add(matchedCandidate.id);
      saveProcessedIds(db, processedIds);
    }

    console.log(`[correlator] transaction ${transaction.id} matched: ${result.merchant_clean} (confidence ${result.confidence})`);
    return;
  }

  console.log(
    `[correlator] transaction ${transaction.id} not confidently matched yet (matched=${result.matched}, confidence=${result.confidence}), will retry`
  );
}

export async function runCorrelationCheck(
  transaction: Transaction,
  candidates: CandidateReceipt[]
): Promise<CorrelationResult | null> {
  const systemPrompt = `You are a financial transaction matcher. Given a UPI bank debit and a list of merchant receipt emails, determine if any receipt matches the debit. Match on: (1) amount within 2% tolerance, (2) time proximity (receipt within 30 mins of debit), (3) plausibility (Uber receipt for a plausible Uber fare amount etc).
Respond ONLY with valid JSON in this exact shape:
{
  "matched": boolean,
  "matched_sender": string | null,
  "merchant_clean": string | null,
  "category": string | null,
  "confidence": number,
  "reasoning": string
}
If category is set, it must be exactly one of: ${CATEGORIES.join(", ")}.`;

  const userPrompt = JSON.stringify({
    upi_debit: {
      amount: transaction.amount,
      currency: "INR",
      datetime: transaction.datetime,
      vpa: transaction.merchant_raw,
    },
    candidate_receipts: candidates.map((c) => ({
      sender: c.sender,
      subject: c.subject,
      snippet: c.snippet,
      datetime: c.datetime,
    })),
  });

  try {
    const openai = getClient();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    return parseCorrelationResponse(raw);
  } catch (err) {
    console.error("[correlator] GPT-4o correlation check failed:", err);
    return null;
  }
}

function parseCorrelationResponse(raw: string): CorrelationResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  if (typeof o.matched !== "boolean") return null;
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1) return null;
  if (o.matched_sender !== null && typeof o.matched_sender !== "string") return null;
  if (o.merchant_clean !== null && typeof o.merchant_clean !== "string") return null;
  if (o.category !== null && typeof o.category !== "string") return null;
  if (typeof o.reasoning !== "string") return null;

  return {
    matched: o.matched,
    matched_sender: (o.matched_sender as string | null) ?? null,
    merchant_clean: (o.merchant_clean as string | null) ?? null,
    category: (o.category as string | null) ?? null,
    confidence: o.confidence,
    reasoning: o.reasoning,
  };
}

async function updateTelegramMessage(
  db: Database.Database,
  transaction: Transaction,
  inference: InferenceOutcome
): Promise<void> {
  const messageId = getMessageIdForTransaction(db, transaction.id);
  if (!messageId) {
    console.log(`[correlator] no telegram message found for transaction ${transaction.id}, skipping edit`);
    return;
  }

  const spendMonth = inference.entry ? getSpendMonthForEntry(inference.entry) : null;
  const summary = spendMonth ? aggregateSpendMonth(db, { spend_month: spendMonth }) : undefined;
  const text = formatV2Transaction(transaction, {
    status: inference.status,
    entry: inference.entry,
    spend_month: spendMonth ?? undefined,
    spend_month_remaining: summary?.personal_remaining,
    question: inference.question,
  });
  await editMessage(messageId, text);
}

async function inferAfterCorrelation(db: Database.Database, transactionId: string): Promise<InferenceOutcome> {
  if (!isAutoInferenceEnabled()) {
    return {
      status: "failed",
      raw_transaction_id: transactionId,
      error: "automatic inference is disabled",
    };
  }
  return inferRawTransaction(db, transactionId);
}
