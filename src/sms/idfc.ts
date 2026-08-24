import { createHash } from "node:crypto";
import { newId } from "../db/schema";
import type { ParsedTransaction } from "../gmail/parsers";

const DEBIT_PATTERN =
  /^Your A\/c\s+X{2}(\d{4})\s+debited by Rs\.?\s*([\d,]+\.\d{2})\s+on\s+(\d{2})\/(\d{2})\/(\d{2});\s*(.+?)\s+credited\.\s*RRN\s+(\d{8,16})\.\s*Available balance Rs\.?\s*[\d,]+\.\d{2}\.\s*Team IDFC FIRST Bank$/i;

const CREDIT_PATTERN =
  /^Your A\/C\s+X+(\d{4,})\s+is credited with INR\s*([\d,]+\.\d{2})\s+on\s+(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\.\s*Your new balance is INR\s*[\d,]+\.\d{2}\.\s*Team IDFC FIRST Bank$/i;

const SENSITIVE_MARKERS = /\b(?:OTP|one[ -]?time password|UPI PIN|CVV|verification code)\b/i;

export interface ParsedIdfcSms {
  parsed: ParsedTransaction;
  message_hash: string;
  kind: "debit" | "credit";
}

export function normalizeSmsMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function hashSmsMessage(message: string): string {
  return createHash("sha256").update(normalizeSmsMessage(message)).digest("hex");
}

export function parseIdfcTransactionSms(
  message: string,
  receivedAt: string
): ParsedIdfcSms | null {
  const normalized = normalizeSmsMessage(message);
  if (!normalized || normalized.length > 2_000 || SENSITIVE_MARKERS.test(normalized)) return null;

  const debit = normalized.match(DEBIT_PATTERN);
  if (debit) {
    const [, accountLast4, amountText, day, month, year, counterpartyText, rrn] = debit;
    const datetime = dateWithReceiptTime(day, month, year, receivedAt);
    if (!datetime) return null;
    const amount = parseAmount(amountText);
    if (amount === null) return null;
    const counterparty = normalizeCounterparty(counterpartyText);
    const rawId = `sms:idfc:rrn:${rrn}`;
    return {
      kind: "debit",
      message_hash: hashSmsMessage(normalized),
      parsed: {
        id: newId(),
        source: "idfc_upi",
        amount,
        merchant_raw: counterparty,
        datetime,
        card_last4: accountLast4,
        raw_email_id: rawId,
        is_reversal: false,
        currency: "INR",
        amount_inr: amount,
        is_international: false,
        notes: `upi_ref:${rrn}`,
        envelope_impact: null,
        is_preauth: false,
        direction: "debit",
        correlation_status: "pending",
      },
    };
  }

  const credit = normalized.match(CREDIT_PATTERN);
  if (credit) {
    const [, accountDigits, amountText, day, month, year, hour, minute] = credit;
    const accountLast4 = accountDigits.slice(-4);
    const datetime = exactIstDatetime(day, month, year, hour, minute);
    if (!datetime) return null;
    const amount = parseAmount(amountText);
    if (amount === null) return null;
    const messageHash = hashSmsMessage(normalized);
    return {
      kind: "credit",
      message_hash: messageHash,
      parsed: {
        id: newId(),
        source: "idfc_upi",
        amount,
        merchant_raw: "Incoming IDFC credit",
        datetime,
        card_last4: accountLast4,
        raw_email_id: `sms:idfc:sha256:${messageHash}`,
        is_reversal: false,
        currency: "INR",
        amount_inr: amount,
        is_international: false,
        notes: "sms_credit_sender_unknown",
        envelope_impact: null,
        is_preauth: false,
        direction: "credit",
        correlation_status: "none",
      },
    };
  }

  return null;
}

function parseAmount(value: string): number | null {
  const amount = Number(value.replaceAll(",", ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeCounterparty(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function twoDigitYear(value: string): number {
  return 2000 + Number(value);
}

function exactIstDatetime(
  day: string,
  month: string,
  year: string,
  hour: string,
  minute: string
): string | null {
  if (!isValidDateParts(day, month, year, hour, minute)) return null;
  const local = `${twoDigitYear(year)}-${month}-${day}T${hour}:${minute}:00+05:30`;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateWithReceiptTime(
  day: string,
  month: string,
  year: string,
  receivedAt: string
): string | null {
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(received);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  if (!hour || !minute || !second) return null;
  if (!isValidDateParts(day, month, year, hour, minute)) return null;
  const local = `${twoDigitYear(year)}-${month}-${day}T${hour}:${minute}:${second}+05:30`;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isValidDateParts(
  day: string,
  month: string,
  year: string,
  hour: string,
  minute: string
): boolean {
  const numericDay = Number(day);
  const numericMonth = Number(month);
  const numericYear = twoDigitYear(year);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  if (
    !Number.isInteger(numericDay) ||
    !Number.isInteger(numericMonth) ||
    !Number.isInteger(numericHour) ||
    !Number.isInteger(numericMinute) ||
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericHour < 0 ||
    numericHour > 23 ||
    numericMinute < 0 ||
    numericMinute > 59
  ) {
    return false;
  }
  const candidate = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
  return (
    candidate.getUTCFullYear() === numericYear &&
    candidate.getUTCMonth() === numericMonth - 1 &&
    candidate.getUTCDate() === numericDay
  );
}
