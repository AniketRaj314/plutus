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

  const datetime = buildIsoDatetime(dateStr);
  if (!datetime) return null;

  const amountMatch = amountStr.match(/([A-Z]{3})\s+([\d,.]+)/);
  if (!amountMatch) return null;
  const [, currency, amountDigits] = amountMatch;
  const amount = Number(amountDigits.replace(/,/g, ""));

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
  };
}

function valueAfterLabel(paragraphs: string[], label: string): string | null {
  const index = paragraphs.findIndex((p) => p === label);
  if (index === -1 || index + 1 >= paragraphs.length) return null;
  return paragraphs[index + 1];
}

function buildIsoDatetime(dateStr: string): string | null {
  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;

  const [, dayStr, monthStr, yearStr] = match;
  const month = MONTHS[monthStr.toLowerCase()];
  if (month === undefined) return null;

  const mm = String(month + 1).padStart(2, "0");
  const dd = String(Number(dayStr)).padStart(2, "0");

  const isoWithOffset = `${yearStr}-${mm}-${dd}T00:00:00+05:30`;
  const parsed = new Date(isoWithOffset);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
