import type Database from "better-sqlite3";
import { newId } from "./schema";
import type { Transaction } from "./queries";

export type EvidenceChannel = "gmail" | "sms" | "manual";

export interface TransactionEvidenceInput {
  raw_transaction_id: string;
  channel: EvidenceChannel;
  external_id: string;
  received_at?: string | null;
  sender_label?: string | null;
  bank_reference?: string | null;
  raw_payload: string;
}

export function recordTransactionEvidence(
  db: Database.Database,
  input: TransactionEvidenceInput
): void {
  db.prepare(
    `INSERT OR IGNORE INTO transaction_evidence (
      id, raw_transaction_id, channel, external_id, received_at,
      sender_label, bank_reference, raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    input.raw_transaction_id,
    input.channel,
    input.external_id,
    input.received_at ?? null,
    input.sender_label ?? null,
    input.bank_reference ?? null,
    input.raw_payload
  );
}

export function findTransactionByEvidence(
  db: Database.Database,
  channel: EvidenceChannel,
  externalId: string
): Transaction | undefined {
  return db
    .prepare(
      `SELECT t.*
       FROM transaction_evidence e
       JOIN transactions t ON t.id = e.raw_transaction_id
       WHERE e.channel = ? AND e.external_id = ?`
    )
    .get(channel, externalId) as Transaction | undefined;
}

function extractUpiReference(notes: string | null | undefined): string | null {
  return notes?.match(/\bupi_ref:([A-Za-z0-9-]+)/i)?.[1] ?? null;
}

export function findIdfcUpiCrossChannelMatch(
  db: Database.Database,
  input: {
    amount: number;
    datetime: string;
    direction: "debit" | "credit";
    notes?: string | null;
  }
): Transaction | undefined {
  const reference = extractUpiReference(input.notes);
  if (reference) {
    return db
      .prepare(
        `SELECT DISTINCT t.*
         FROM transactions t
         LEFT JOIN transaction_evidence e ON e.raw_transaction_id = t.id
         WHERE t.source = 'idfc_upi'
           AND (
             lower(COALESCE(e.bank_reference, '')) = lower(?)
             OR instr(lower(COALESCE(t.notes, '')), lower(?)) > 0
           )
         ORDER BY t.created_at ASC
         LIMIT 1`
      )
      .get(reference, `upi_ref:${reference}`) as Transaction | undefined;
  }

  if (input.direction !== "credit") return undefined;
  const occurredAt = new Date(input.datetime).getTime();
  if (!Number.isFinite(occurredAt)) return undefined;

  const candidates = db
    .prepare(
      `SELECT * FROM transactions
       WHERE source = 'idfc_upi'
         AND direction = 'credit'
         AND abs(amount - ?) < 0.005
       ORDER BY datetime DESC
       LIMIT 20`
    )
    .all(input.amount) as Transaction[];
  const close = candidates.filter((candidate) => {
    const candidateAt = candidate.datetime ? new Date(candidate.datetime).getTime() : NaN;
    return Number.isFinite(candidateAt) && Math.abs(candidateAt - occurredAt) <= 60_000;
  });
  return close.length === 1 ? close[0] : undefined;
}
