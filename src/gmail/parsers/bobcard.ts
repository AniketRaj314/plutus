import type { EmailContent, ParsedFields } from "./types";

const TRANSACTION_PATTERN =
  /ending in\s*(\d{4}).*?Amount:\s*INR\s*([\d,]+\.\d{2})\s*Merchant:\s*(.+?)\s*Date:\s*(\d{2})\/(\d{2})\/(\d{4})\s*Time:\s*(\d{2}):(\d{2}):(\d{2})/is;

export function parseBobCard(email: EmailContent): ParsedFields | null {
  if (!email.subject.includes("Payment update on your BOBCARD One credit card")) return null;

  const match = email.body.match(TRANSACTION_PATTERN);
  if (!match) return null;

  const [, last4, amountStr, merchantRaw, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr] =
    match;

  const isoWithOffset = `${yearStr}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:${secondStr}+05:30`;
  const parsed = new Date(isoWithOffset);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    source: "bobcard",
    amount: Number(amountStr.replace(/,/g, "")),
    merchant_raw: merchantRaw.trim(),
    datetime: parsed.toISOString(),
    card_last4: last4,
    is_reversal: false,
  };
}
