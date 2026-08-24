import cron from "node-cron";
import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { newId } from "../db/schema";
import {
  findIdfcUpiCrossChannelMatch,
  findTransactionByEvidence,
  recordTransactionEvidence,
} from "../db/evidence";
import {
  getTransaction,
  getTransactionByRawEmailId,
  insertTransaction,
} from "../db/queries";
import { insertRawTransaction } from "../db/v2-queries";
import { enrichTransaction } from "../enrichment/gpt";
import { finalizeTransaction, type ProcessMessageOptions } from "../gmail/poller";
import { getMessageIdForTransaction, sendMessage } from "../telegram/bot";
import {
  configureScheduler,
  runSchedulerCycle,
} from "../scheduler/status";
import { sanitizeAgentErrorMessage } from "../agent/diagnostics";
import { hashSmsMessage, normalizeSmsMessage, parseIdfcTransactionSms } from "./idfc";

const RETRY_INTERVAL_MINUTES = 5;
const MAX_PROCESSING_ATTEMPTS = 3;

export interface IdfcSmsWebhookInput {
  message: string;
  received_at: string;
  device_label?: string;
  shortcut_version?: string;
}

export interface SmsIngestionDiagnostic {
  error_ref: string;
  event_id: string;
  occurred_at: string;
  status: string;
  safe_message: string;
  attempts: number;
  message_hash: string;
}

export interface SmsIngestionStatus {
  configured: boolean;
  last_received_at: string | null;
  last_processed_at: string | null;
  pending_count: number;
  failed_count: number;
}

export type SmsAcceptanceResult =
  | {
      status: "accepted" | "duplicate";
      event_id: string;
      raw_transaction_id: string;
      should_process: boolean;
    }
  | {
      status: "rejected";
      event_id: string;
      error_ref: string;
      safe_message: string;
    };

interface SmsEventRow {
  id: string;
  status: "stored" | "processed" | "duplicate" | "rejected" | "error";
  raw_transaction_id: string | null;
  attempts: number;
  error_ref: string | null;
  created_at: string;
}

function smsErrorReference(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = nanoid(6).replace(/[^A-Za-z0-9]/g, "X").toUpperCase();
  return `SMS-${date}-${suffix}`;
}

function digestToken(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isValidSmsIngestToken(received: string | undefined): boolean {
  const expected = process.env.SMS_INGEST_TOKEN;
  if (!expected || !received) return false;
  return timingSafeEqual(digestToken(expected), digestToken(received));
}

function cleanMetadata(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || null;
}

function createRejectedEvent(
  db: Database.Database,
  input: IdfcSmsWebhookInput,
  messageHash: string,
  safeMessage: string
): SmsAcceptanceResult {
  const id = newId();
  const errorRef = smsErrorReference();
  db.prepare(
    `INSERT INTO sms_ingestion_events (
      id, message_hash, received_at, device_label, shortcut_version,
      status, error_ref, safe_message
    ) VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?)`
  ).run(
    id,
    messageHash,
    input.received_at,
    cleanMetadata(input.device_label, 80),
    cleanMetadata(input.shortcut_version, 40),
    errorRef,
    safeMessage
  );
  return { status: "rejected", event_id: id, error_ref: errorRef, safe_message: safeMessage };
}

function evidencePayload(input: IdfcSmsWebhookInput, messageHash: string): string {
  return JSON.stringify({
    channel: "sms",
    message: normalizeSmsMessage(input.message),
    message_hash: messageHash,
    received_at: input.received_at,
    device_label: cleanMetadata(input.device_label, 80),
    shortcut_version: cleanMetadata(input.shortcut_version, 40),
  });
}

export function acceptIdfcSms(
  db: Database.Database,
  input: IdfcSmsWebhookInput
): SmsAcceptanceResult {
  const receivedAt = new Date(input.received_at);
  const fallbackHash = hashSmsMessage(input.message ?? "");
  if (!input.message || input.message.length > 2_000 || Number.isNaN(receivedAt.getTime())) {
    return createRejectedEvent(
      db,
      { ...input, received_at: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : input.received_at },
      fallbackHash,
      "Invalid SMS payload or receipt timestamp"
    );
  }

  const result = parseIdfcTransactionSms(input.message, input.received_at);
  if (!result) {
    return createRejectedEvent(
      db,
      input,
      fallbackHash,
      "Message did not match the allowed IDFC debit or credit transaction formats"
    );
  }

  const { parsed, message_hash: messageHash } = result;
  const repeatedEvent = db
    .prepare(
      `SELECT id, status, raw_transaction_id, attempts, error_ref, created_at
       FROM sms_ingestion_events
       WHERE message_hash = ? AND raw_transaction_id IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(messageHash) as SmsEventRow | undefined;
  if (repeatedEvent?.raw_transaction_id) {
    return {
      status: "duplicate",
      event_id: repeatedEvent.id,
      raw_transaction_id: repeatedEvent.raw_transaction_id,
      should_process:
        ["stored", "error"].includes(repeatedEvent.status) &&
        !getMessageIdForTransaction(db, repeatedEvent.raw_transaction_id),
    };
  }

  const bankReference = parsed.notes?.match(/\bupi_ref:([A-Za-z0-9-]+)/i)?.[1] ?? null;
  const existing =
    getTransactionByRawEmailId(db, parsed.raw_email_id) ??
    findTransactionByEvidence(db, "sms", parsed.raw_email_id) ??
    findIdfcUpiCrossChannelMatch(db, {
      amount: parsed.amount,
      datetime: parsed.datetime,
      direction: parsed.direction,
      notes: parsed.notes,
    });
  const eventId = newId();
  const payload = evidencePayload(input, messageHash);

  if (existing) {
    recordTransactionEvidence(db, {
      raw_transaction_id: existing.id,
      channel: "sms",
      external_id: parsed.raw_email_id,
      received_at: input.received_at,
      sender_label: result.kind === "debit" ? "IDFCFB-T" : "IDFCFB-S",
      bank_reference: bankReference,
      raw_payload: payload,
    });
    const shouldProcess = !getMessageIdForTransaction(db, existing.id);
    db.prepare(
      `INSERT INTO sms_ingestion_events (
        id, message_hash, received_at, device_label, shortcut_version,
        status, raw_transaction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      messageHash,
      input.received_at,
      cleanMetadata(input.device_label, 80),
      cleanMetadata(input.shortcut_version, 40),
      shouldProcess ? "stored" : "duplicate",
      existing.id
    );
    return {
      status: "duplicate",
      event_id: eventId,
      raw_transaction_id: existing.id,
      should_process: shouldProcess,
    };
  }

  const transaction = db.transaction(() => {
    const created = insertTransaction(db, {
      source: parsed.source,
      amount: parsed.amount,
      merchant_raw: parsed.merchant_raw,
      datetime: parsed.datetime,
      card_last4: parsed.card_last4,
      raw_email_id: parsed.raw_email_id,
      is_reversal: 0,
      currency: parsed.currency,
      amount_inr: parsed.amount_inr,
      is_international: 0,
      envelope_impact: null,
      notes: parsed.notes,
      is_preauth: 0,
      direction: parsed.direction,
      correlation_status: parsed.direction === "debit" ? "pending" : "none",
    });
    insertRawTransaction(db, {
      id: created.id,
      source: parsed.source,
      amount: parsed.amount,
      currency: parsed.currency,
      amount_inr: parsed.amount_inr,
      merchant_raw: parsed.merchant_raw,
      occurred_at: parsed.datetime,
      card_last4: parsed.card_last4,
      is_reversal: false,
      is_international: false,
      is_preauth: false,
      direction: parsed.direction,
      raw_email_id: parsed.raw_email_id,
      raw_payload: payload,
    });
    recordTransactionEvidence(db, {
      raw_transaction_id: created.id,
      channel: "sms",
      external_id: parsed.raw_email_id,
      received_at: input.received_at,
      sender_label: result.kind === "debit" ? "IDFCFB-T" : "IDFCFB-S",
      bank_reference: bankReference,
      raw_payload: payload,
    });
    db.prepare(
      `INSERT INTO sms_ingestion_events (
        id, message_hash, received_at, device_label, shortcut_version,
        status, raw_transaction_id
      ) VALUES (?, ?, ?, ?, ?, 'stored', ?)`
    ).run(
      eventId,
      messageHash,
      input.received_at,
      cleanMetadata(input.device_label, 80),
      cleanMetadata(input.shortcut_version, 40),
      created.id
    );
    return created;
  })();

  return {
    status: "accepted",
    event_id: eventId,
    raw_transaction_id: transaction.id,
    should_process: true,
  };
}

function getSmsEvent(db: Database.Database, eventId: string): SmsEventRow | undefined {
  return db.prepare("SELECT * FROM sms_ingestion_events WHERE id = ?").get(eventId) as
    | SmsEventRow
    | undefined;
}

export async function completeSmsIngestion(
  db: Database.Database,
  eventId: string,
  options: ProcessMessageOptions = {}
): Promise<void> {
  const event = getSmsEvent(db, eventId);
  if (!event?.raw_transaction_id || !["stored", "error"].includes(event.status)) return;
  const transaction = getTransaction(db, event.raw_transaction_id);
  if (!transaction) throw new Error(`SMS transaction ${event.raw_transaction_id} is missing`);

  const attempt = event.attempts + 1;
  db.prepare(
    `UPDATE sms_ingestion_events
     SET attempts = ?, last_attempt_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(attempt, new Date().toISOString(), eventId);

  try {
    if (!getMessageIdForTransaction(db, transaction.id)) {
      const enrich = options.enrich ?? enrichTransaction;
      if (!transaction.merchant_clean) await enrich(db, transaction);
      await finalizeTransaction(db, getTransaction(db, transaction.id) ?? transaction, options);
    }
    db.prepare(
      `UPDATE sms_ingestion_events
       SET status = 'processed', error_ref = NULL, safe_message = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(eventId);
  } catch (error) {
    const errorRef = event.error_ref ?? smsErrorReference();
    const safeMessage = sanitizeAgentErrorMessage(error);
    db.prepare(
      `UPDATE sms_ingestion_events
       SET status = 'error', error_ref = ?, safe_message = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(errorRef, safeMessage, eventId);
    try {
      await (options.sendTelegram ?? sendMessage)(
        `⚠️ IDFC SMS transaction processing failed.\nError ID: ${errorRef}\n` +
          `The raw transaction is safely stored and will be retried.`
      );
    } catch {
      // The original error may itself be Telegram availability. The persisted
      // diagnostic and retry worker remain the recovery path.
    }
    throw error;
  }
}

export async function processPendingSmsIngestions(
  db: Database.Database,
  options: ProcessMessageOptions = {}
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT id FROM sms_ingestion_events
       WHERE status IN ('stored', 'error') AND attempts < ?
       ORDER BY created_at ASC
       LIMIT 20`
    )
    .all(MAX_PROCESSING_ATTEMPTS) as Array<{ id: string }>;
  const failures: string[] = [];
  for (const row of rows) {
    try {
      await completeSmsIngestion(db, row.id, options);
    } catch {
      failures.push(row.id);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} SMS ingestion event(s) failed and remain queued`);
  }
}

export function startSmsIngestionRetry(db: Database.Database): void {
  configureScheduler("sms_ingestion", {
    label: "IDFC SMS ingestion retry",
    interval_minutes: RETRY_INTERVAL_MINUTES,
    enabled: Boolean(process.env.SMS_INGEST_TOKEN),
  });
  cron.schedule(`*/${RETRY_INTERVAL_MINUTES} * * * *`, () => {
    if (!process.env.SMS_INGEST_TOKEN) return;
    void runSchedulerCycle("sms_ingestion", () => processPendingSmsIngestions(db));
  });
}

export function getSmsIngestionStatus(db: Database.Database): SmsIngestionStatus {
  const latest = db
    .prepare("SELECT received_at FROM sms_ingestion_events ORDER BY created_at DESC LIMIT 1")
    .get() as { received_at: string } | undefined;
  const processed = db
    .prepare(
      `SELECT updated_at FROM sms_ingestion_events
       WHERE status IN ('processed', 'duplicate')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get() as { updated_at: string } | undefined;
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('stored', 'error') AND attempts < ? THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status = 'error' AND attempts >= ? THEN 1 ELSE 0 END) AS failed_count
       FROM sms_ingestion_events`
    )
    .get(MAX_PROCESSING_ATTEMPTS, MAX_PROCESSING_ATTEMPTS) as {
      pending_count: number | null;
      failed_count: number | null;
    };
  return {
    configured: Boolean(process.env.SMS_INGEST_TOKEN),
    last_received_at: latest?.received_at ?? null,
    last_processed_at: processed?.updated_at ?? null,
    pending_count: counts.pending_count ?? 0,
    failed_count: counts.failed_count ?? 0,
  };
}

export function getSmsIngestionError(
  db: Database.Database,
  errorRef: string
): SmsIngestionDiagnostic | undefined {
  return db
    .prepare(
      `SELECT error_ref, id AS event_id, received_at AS occurred_at, status,
              safe_message, attempts, message_hash
       FROM sms_ingestion_events
       WHERE error_ref = ?`
    )
    .get(errorRef.trim().toUpperCase()) as SmsIngestionDiagnostic | undefined;
}
