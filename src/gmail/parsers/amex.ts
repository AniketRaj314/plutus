import { parse } from "node-html-parser";
import type { EmailContent, ParsedFields } from "./types";
import { parseAmexAmount } from "./amex-amount";
import { isAmexTransactionSubject } from "../senders";

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

export function parseAmex(email: EmailContent): ParsedFields | null {
  if (!isAmexTransactionSubject(email.subject)) return null;
  if (!email.htmlBody) return null;

  const root = parse(email.htmlBody);
  const blocks = root
    .querySelectorAll("p, td")
    // Nested layout tables repeat their descendants' text. Only read leaf
    // blocks, in document order, for both the old paragraphs and new cells.
    .filter((node) => !node.querySelector("p, td"))
    .map((node) => node.text.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);

  const dateStr = valueAfterLabel(blocks, "Date:");
  const merchantRaw = valueAfterLabel(blocks, "Merchant:");
  const amountStr = valueAfterLabel(blocks, "Amount:");
  if (!dateStr || !merchantRaw || !amountStr) return null;

  const datetime = buildIsoDatetime(dateStr, email.receivedAt);
  if (!datetime) return null;

  const parsedAmount = parseAmexAmount(amountStr);
  if (!parsedAmount) return null;
  const { currency, amount } = parsedAmount;

  const endingMatch = blocks
    .join("\n")
    .match(/Account\s+Ending:\s*(\d{4,5})\b/i);
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

function valueAfterLabel(blocks: string[], label: string): string | null {
  const values = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].toLowerCase() === label.toLowerCase() && blocks[i + 1])
      values.add(blocks[i + 1]);
  }
  // Responsive duplicates are fine only if they agree. Never guess between
  // multiple transactions or conflicting amount/date fields in one message.
  return values.size === 1 ? [...values][0] : null;
}

function buildIsoDatetime(dateStr: string, receivedAt?: string): string | null {
  const named = dateStr.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const numeric = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!named && !numeric) return null;
  const day = Number((named ?? numeric)![1]);
  const year = Number((named ?? numeric)![3]);
  const month = named
    ? MONTHS[named[2].toLowerCase()]
    : Number(numeric![2]) - 1;
  if (month === undefined || month < 0 || month > 11 || year < 1000)
    return null;
  const calendar = new Date(Date.UTC(year, month, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month ||
    calendar.getUTCDate() !== day
  )
    return null;

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
    Date.UTC(year, month, day, hour, minute, second, millisecond) -
      IST_OFFSET_MS,
  );
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
