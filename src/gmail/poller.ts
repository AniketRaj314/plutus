import cron from "node-cron";
import type Database from "better-sqlite3";
import type { gmail_v1 } from "googleapis";
import { getGmailClient } from "./auth";
import { getContext, setContext, getTransaction, getTransactionByRawEmailId, findTransactionByContentKey, insertTransaction } from "../db/queries";
import { parseGmailMessage } from "./parsers";
import { enrichTransaction } from "../enrichment/gpt";
import { sendMessage, recordTransactionMessage, getMessageIdForTransaction } from "../telegram/bot";
import { formatV2Transaction } from "../telegram/formatter";
import { aggregateEnvelopeEntries, insertRawTransaction } from "../db/v2-queries";
import {
  inferRawTransaction,
  isAutoInferenceEnabled,
  type InferenceGenerator,
  type InferenceOutcome,
} from "../agent/inference";
import {
  configureScheduler,
  normalizeCronInterval,
  runSchedulerCycle,
} from "../scheduler/status";

const WATCHED_SENDERS = [
  "noreply@idfcfirstbank.com",
  "no-reply@getonecard.app",
  "AmericanExpress@welcome.americanexpress.com",
];

const LAST_POLL_KEY = "last_gmail_poll";
const PROCESSED_IDS_KEY = "processed_message_ids";
const MAX_PROCESSED_IDS = 2000;
const activePollDatabases = new WeakSet<Database.Database>();

export function startPoller(db: Database.Database): void {
  const intervalMins = normalizeCronInterval(process.env.POLL_INTERVAL_MINS, 10);
  const schedule = `*/${intervalMins} * * * *`;

  const lastPollSeconds = Number(getContext(db, LAST_POLL_KEY)?.value);
  configureScheduler("gmail_poll", {
    label: "Gmail transaction poller",
    interval_minutes: intervalMins,
    enabled: true,
    last_completed_at: Number.isFinite(lastPollSeconds)
      ? new Date(lastPollSeconds * 1000).toISOString()
      : null,
  });

  cron.schedule(schedule, () => {
    void runSchedulerCycle("gmail_poll", () => pollOnce(db));
  });

  console.log(`Gmail poller scheduled every ${intervalMins} minute(s)`);
}

export async function pollOnce(db: Database.Database): Promise<void> {
  if (activePollDatabases.has(db)) {
    console.log("[gmail] previous poll is still running, skipping overlapping cron tick");
    return;
  }
  activePollDatabases.add(db);
  try {
    const gmail = getGmailClient();
    const sinceSeconds = getLastPollTimestamp(db);
    const processedIds = getProcessedIds(db);

    const query = `from:(${WATCHED_SENDERS.join(" OR ")}) after:${sinceSeconds}`;
    const messageIds = await listMessageIds(gmail, query);
    const newIds = messageIds.filter((id) => !processedIds.has(id));

    for (const id of newIds) {
      const message = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });

      await processMessage(db, message.data);
      processedIds.add(id);
    }

    saveProcessedIds(db, processedIds);
    setContext(db, LAST_POLL_KEY, String(Math.floor(Date.now() / 1000)));

    console.log(
      newIds.length === 0
        ? "[gmail] poll complete, no new messages"
        : `[gmail] poll complete, ${newIds.length} new message(s) processed`
    );
  } catch (err) {
    console.error("[gmail] poll cycle failed:", err);
    throw err;
  } finally {
    activePollDatabases.delete(db);
  }
}

export interface ProcessMessageOptions {
  inferenceGenerator?: InferenceGenerator;
  minConfidence?: number;
  sendTelegram?: (text: string, replyToMessageId?: number) => Promise<number>;
}

export async function processMessage(
  db: Database.Database,
  message: gmail_v1.Schema$Message,
  options: ProcessMessageOptions = {}
): Promise<void> {
  const headers = message.payload?.headers ?? [];
  const from = headers.find((h) => h.name === "From")?.value ?? "(unknown sender)";
  const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
  const snippet = message.snippet ?? "";
  const id = message.id ?? "(unknown id)";

  console.log(`[gmail] from="${from}" subject="${subject}" snippet="${snippet}" id=${id}`);

  const parsed = parseGmailMessage(message);
  if (!parsed) {
    console.log(`[gmail] no parser matched or unparseable, skipping id=${id}`);
    return;
  }

  const existing = getTransactionByRawEmailId(db, parsed.raw_email_id);
  if (existing) {
    if (getMessageIdForTransaction(db, existing.id)) {
      console.log(`[gmail] transaction already completed for raw_email_id=${parsed.raw_email_id}, skipping`);
      return;
    }
    console.log(`[gmail] recovering incomplete processing for raw_email_id=${parsed.raw_email_id}`);
    if (!existing.merchant_clean) await enrichTransaction(db, existing);
    await finalizeTransaction(db, getTransaction(db, existing.id) ?? existing, options);
    return;
  }

  const minuteKey = parsed.datetime.slice(0, 16);
  const contentDuplicate = findTransactionByContentKey(
    db,
    parsed.source,
    parsed.amount,
    parsed.merchant_raw,
    minuteKey
  );
  if (contentDuplicate) {
    console.log(
      `[gmail] duplicate transaction content (same amount/merchant/minute) already recorded as ${contentDuplicate.id}, skipping raw_email_id=${parsed.raw_email_id}`
    );
    return;
  }

  const transaction = insertTransaction(db, {
    source: parsed.source,
    amount: parsed.amount,
    merchant_raw: parsed.merchant_raw,
    datetime: parsed.datetime,
    card_last4: parsed.card_last4,
    raw_email_id: parsed.raw_email_id,
    is_reversal: parsed.is_reversal ? 1 : 0,
    currency: parsed.currency,
    amount_inr: parsed.amount_inr,
    is_international: parsed.is_international ? 1 : 0,
    envelope_impact: parsed.envelope_impact,
    notes: parsed.notes,
    is_preauth: parsed.is_preauth ? 1 : 0,
    correlation_status: parsed.correlation_status ?? "none",
  });

  insertRawTransaction(db, {
    id: transaction.id,
    source: parsed.source,
    amount: parsed.amount,
    currency: parsed.currency,
    amount_inr: parsed.amount_inr,
    merchant_raw: parsed.merchant_raw,
    occurred_at: parsed.datetime,
    card_last4: parsed.card_last4,
    is_reversal: parsed.is_reversal,
    is_international: parsed.is_international,
    is_preauth: parsed.is_preauth,
    raw_email_id: parsed.raw_email_id,
    raw_payload: JSON.stringify({ from, subject, snippet }),
  });

  console.log(
    `[gmail] parsed transaction: source=${transaction.source} amount=${transaction.amount} currency=${transaction.currency} merchant="${transaction.merchant_raw ?? "(none)"}" datetime=${transaction.datetime} card_last4=${transaction.card_last4} is_reversal=${transaction.is_reversal} is_international=${transaction.is_international} id=${transaction.id}`
  );

  await enrichTransaction(db, transaction);
  await finalizeTransaction(db, getTransaction(db, transaction.id) ?? transaction, options);
}

async function finalizeTransaction(
  db: Database.Database,
  transaction: NonNullable<ReturnType<typeof getTransaction>>,
  options: ProcessMessageOptions
): Promise<void> {
  const sendTelegram = options.sendTelegram ?? sendMessage;

  if (transaction.source === "idfc_upi" && transaction.correlation_status === "pending") {
    // Envelope apply and final formatting are deferred to the correlation
    // engine (src/enrichment/correlator.ts) — it edits this same message
    // in-place once a matching merchant receipt is found or the 30-minute
    // window expires.
    const pendingText = formatV2Transaction(transaction, { status: "correlating" });
    try {
      const messageId = await sendTelegram(pendingText);
      recordTransactionMessage(db, messageId, transaction.id);
      console.log(`[telegram] sent pending UPI message ${messageId} for transaction ${transaction.id}`);
    } catch (err) {
      console.error(`[telegram] failed to send pending UPI message for transaction ${transaction.id}:`, err);
      throw err;
    }
    return;
  }

  let inference: InferenceOutcome = {
    status: "failed",
    raw_transaction_id: transaction.id,
    error: "automatic inference is disabled",
  };
  if (isAutoInferenceEnabled() || options.inferenceGenerator) {
    inference = await inferRawTransaction(db, transaction.id, {
      generate: options.inferenceGenerator,
      minConfidence: options.minConfidence,
    });
  }

  const summary = inference.entry
    ? aggregateEnvelopeEntries(db, { funding_month: inference.entry.funding_month })
    : undefined;
  const messageText = formatV2Transaction(transaction, {
    status: inference.status,
    entry: inference.entry,
    personal_remaining: summary?.personal_remaining,
    question: inference.question,
  });

  try {
    const messageId = await sendTelegram(messageText);
    recordTransactionMessage(db, messageId, transaction.id);
    console.log(`[telegram] sent transaction message ${messageId} for transaction ${transaction.id}`);
  } catch (err) {
    console.error(`[telegram] failed to send message for transaction ${transaction.id}:`, err);
    throw err;
  }
}

async function listMessageIds(gmail: gmail_v1.Gmail, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    // Intentionally no labelIds filter (e.g. CATEGORY_PRIMARY) — the
    // sender-scoped `q` query above is tight enough on its own, and we want
    // bank alert emails picked up regardless of which Gmail tab (Primary,
    // Updates, Promotions, etc.) they land in.
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      pageToken,
      maxResults: 100,
    });

    for (const msg of res.data.messages ?? []) {
      if (msg.id) ids.push(msg.id);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

function getLastPollTimestamp(db: Database.Database): number {
  const row = getContext(db, LAST_POLL_KEY);
  if (!row?.value) {
    const intervalMins = normalizeCronInterval(process.env.POLL_INTERVAL_MINS, 10);
    return Math.floor(Date.now() / 1000) - intervalMins * 60;
  }
  return Number(row.value);
}

export function getProcessedIds(db: Database.Database): Set<string> {
  const row = getContext(db, PROCESSED_IDS_KEY);
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function saveProcessedIds(db: Database.Database, ids: Set<string>): void {
  const trimmed = Array.from(ids).slice(-MAX_PROCESSED_IDS);
  setContext(db, PROCESSED_IDS_KEY, JSON.stringify(trimmed));
}
