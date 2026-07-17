import { parse } from "node-html-parser";
import type { EmailContent, ParsedFields } from "./types";

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD",
  "₹": "INR",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

export function parseAmex(email: EmailContent): ParsedFields | null {
  if (!email.subject.includes("Your transaction update")) return null;
  if (!email.htmlBody) return null;

  const root = parse(email.htmlBody);
  const paragraphs = root
    .querySelectorAll("p")
    .map((p) => p.text.replace(/ /g, " ").trim())
    .filter((t) => t.length > 0);

  const dateStr = valueAfterLabel(paragraphs, "Date:");
  const merchantRaw = valueAfterLabel(paragraphs, "Merchant:");
  const amountStr = valueAfterLabel(paragraphs, "Amount:");
  if (!dateStr || !merchantRaw || !amountStr) return null;

  const datetime = buildIsoDatetime(dateStr, email.receivedAt);
  if (!datetime) return null;

  const parsedAmount = parseAmount(amountStr);
  if (!parsedAmount) return null;
  const { currency, amountDigits } = parsedAmount;
  const amount = Number(amountDigits.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  const endingMatch = email.htmlBody.match(/Account Ending:\s*(\d+)/i);
  const cardLast4 = endingMatch ? endingMatch[1] : "";

  if (currency !== "INR") {
    return {
      source: "amex",
      amount,
      merchant_raw: merchantRaw,
      datetime,
      card_last4: cardLast4,
      is_reversal: false,
      currency,
      amount_inr: null,
      is_international: true,
      envelope_impact: 0,
      notes: "pending_forex_resolution",
      is_preauth: false,
      direction: "debit",
    };
  }

  return {
    source: "amex",
    amount,
    merchant_raw: merchantRaw,
    datetime,
    card_last4: cardLast4,
    is_reversal: false,
    currency: "INR",
    amount_inr: null,
    is_international: false,
    envelope_impact: null,
    notes: null,
    is_preauth: false,
    direction: "debit",
  };
}

function parseAmount(value: string): { currency: string; amountDigits: string } | null {
  const codeMatch = value.match(/^\s*([A-Z]{3})\s+([\d,.]+)\s*$/i);
  if (codeMatch) {
    return { currency: codeMatch[1].toUpperCase(), amountDigits: codeMatch[2] };
  }

  const symbolMatch = value.match(/^\s*([$₹€£¥])\s*([\d,.]+)\s*$/);
  if (!symbolMatch) return null;
  const currency = CURRENCY_SYMBOLS[symbolMatch[1]];
  return currency ? { currency, amountDigits: symbolMatch[2] } : null;
}

function valueAfterLabel(paragraphs: string[], label: string): string | null {
  const index = paragraphs.findIndex((p) => p === label);
  if (index === -1 || index + 1 >= paragraphs.length) return null;
  return paragraphs[index + 1];
}

function buildIsoDatetime(dateStr: string, receivedAt?: string): string | null {
  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;

  const [, dayStr, monthStr, yearStr] = match;
  const month = MONTHS[monthStr.toLowerCase()];
  if (month === undefined) return null;

  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;
  if (receivedAt) {
    const received = new Date(receivedAt);
    if (!Number.isNaN(received.getTime())) {
      const receivedIst = new Date(received.getTime() + IST_OFFSET_MS);
      hour = receivedIst.getUTCHours();
      minute = receivedIst.getUTCMinutes();
      second = receivedIst.getUTCSeconds();
      millisecond = receivedIst.getUTCMilliseconds();
    }
  }

  // AmEx supplies the transaction's IST calendar date but no time. Combine
  // that authoritative date with Gmail's receipt time-of-day in IST.
  const parsed = new Date(
    Date.UTC(Number(yearStr), month, Number(dayStr), hour, minute, second, millisecond) - IST_OFFSET_MS
  );
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
