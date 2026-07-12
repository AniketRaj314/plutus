import type { EmailContent, ParsedFields } from "./types";

const TRANSACTION_PATTERN =
  /ending in\s*(\d{4}).*?Amount:\s+([A-Z]{3})\s+([\d,.]+)\s*Merchant:\s*(.+?)\s*Date:\s*(\d{2})\/(\d{2})\/(\d{4})\s*Time:\s*(\d{2}):(\d{2}):(\d{2})/is;

export function parseBobCard(email: EmailContent): ParsedFields | null {
  if (!email.subject.includes("Payment update on your BOBCARD One credit card")) return null;

  const match = email.body.match(TRANSACTION_PATTERN);
  if (!match) return null;

  const [
    ,
    last4,
    currency,
    amountStr,
    merchantRaw,
    dayStr,
    monthStr,
    yearStr,
    hourStr,
    minuteStr,
    secondStr,
  ] = match;

  const isoWithOffset = `${yearStr}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}+05:30`;
  const parsed = new Date(isoWithOffset);
  if (Number.isNaN(parsed.getTime())) return null;

  const amount = Number(amountStr.replace(/,/g, ""));

  if (currency !== "INR") {
    return {
      source: "bobcard",
      amount,
      merchant_raw: merchantRaw.trim(),
      datetime: parsed.toISOString(),
      card_last4: last4,
      is_reversal: false,
      currency,
      amount_inr: null,
      is_international: true,
      envelope_impact: 0,
      notes: "pending_forex_resolution",
    };
  }

  return {
    source: "bobcard",
    amount,
    merchant_raw: merchantRaw.trim(),
    datetime: parsed.toISOString(),
    card_last4: last4,
    is_reversal: false,
    currency: "INR",
    amount_inr: null,
    is_international: false,
    envelope_impact: null,
    notes: null,
  };
}
