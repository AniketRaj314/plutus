import cron from "node-cron";
import type Database from "better-sqlite3";
import type { gmail_v1 } from "googleapis";
import { getGmailClient } from "./auth";
import { getContext, setContext, getTransaction, getTransactionByRawEmailId, findTransactionByContentKey, insertTransaction } from "../db/queries";
import { parseGmailMessage } from "./parsers";
import { enrichTransaction } from "../enrichment/gpt";
import { applyTransaction, getEnvelopeState } from "../envelope/engine";
import { sendMessage, recordTransactionMessage } from "../telegram/bot";
import { formatTransaction } from "../telegram/formatter";

const WATCHED_SENDERS = [
  "noreply@idfcfirstbank.com",
  "no-reply@getonecard.app",
  "AmericanExpress@welcome.americanexpress.com",
];

const LAST_POLL_KEY = "last_gmail_poll";
const PROCESSED_IDS_KEY = "processed_message_ids";
const MAX_PROCESSED_IDS = 2000;

export function startPoller(db: Database.Database): void {
  const intervalMins = Number(process.env.POLL_INTERVAL_MINS) || 10;
  const schedule = `*/${intervalMins} * * * *`;

  cron.schedule(schedule, () => {
    void pollOnce(db);
  });

  console.log(`Gmail poller scheduled every ${intervalMins} minute(s)`);
}

export async function pollOnce(db: Database.Database): Promise<void> {
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
  }
}

export async function processMessage(db: Database.Database, message: gmail_v1.Schema$Message): Promise<void> {
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

  if (getTransactionByRawEmailId(db, parsed.raw_email_id)) {
    console.log(`[gmail] transaction already recorded for raw_email_id=${parsed.raw_email_id}, skipping`);
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

  console.log(
    `[gmail] parsed transaction: source=${transaction.source} amount=${transaction.amount} currency=${transaction.currency} merchant="${transaction.merchant_raw ?? "(none)"}" datetime=${transaction.datetime} card_last4=${transaction.card_last4} is_reversal=${transaction.is_reversal} is_international=${transaction.is_international} id=${transaction.id}`
  );

  await enrichTransaction(db, transaction);

  const enriched = getTransaction(db, transaction.id) ?? transaction;

  if (enriched.source === "idfc_upi" && enriched.correlation_status === "pending") {
    // Envelope apply and final formatting are deferred to the correlation
    // engine (src/enrichment/correlator.ts) — it edits this same message
    // in-place once a matching merchant receipt is found or the 30-minute
    // window expires.
    const pendingText = formatTransaction(enriched, getEnvelopeState(db));
    if (pendingText) {
      try {
        const messageId = await sendMessage(pendingText);
        recordTransactionMessage(db, messageId, enriched.id);
        console.log(`[telegram] sent pending UPI message ${messageId} for transaction ${enriched.id}`);
      } catch (err) {
        console.error(`[telegram] failed to send pending UPI message for transaction ${enriched.id}:`, err);
      }
    }
    return;
  }

  const applyResult = applyTransaction(db, enriched);

  if (applyResult) {
    console.log(
      `[envelope] applied transaction ${enriched.id}: week_remaining=${applyResult.week_remaining.toFixed(2)} month_remaining=${applyResult.month_remaining.toFixed(2)}`
    );
    if (applyResult.triggered_rebalance) {
      setContext(db, "pending_rebalance_message", applyResult.triggered_rebalance.message);
      console.log(`[envelope] rebalance triggered: ${applyResult.triggered_rebalance.message}`);
    }
  }

  const finalTransaction = getTransaction(db, transaction.id) ?? enriched;
  const messageText = formatTransaction(finalTransaction, getEnvelopeState(db));

  if (messageText) {
    try {
      const messageId = await sendMessage(messageText);
      recordTransactionMessage(db, messageId, finalTransaction.id);
      console.log(`[telegram] sent transaction message ${messageId} for transaction ${finalTransaction.id}`);
    } catch (err) {
      console.error(`[telegram] failed to send message for transaction ${finalTransaction.id}:`, err);
    }
  } else {
    console.log(`[telegram] transaction ${finalTransaction.id} is committed, no message sent`);
  }
}

async function listMessageIds(gmail: gmail_v1.Gmail, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
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
    const intervalMins = Number(process.env.POLL_INTERVAL_MINS) || 10;
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
