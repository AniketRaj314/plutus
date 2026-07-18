import type { EmailContent, ParsedFields } from "./types";

const SUBJECT = "Transaction alert for your ICICI Bank Credit Card";

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// "Your ICICI Bank Credit Card XX6017 has been used for a transaction of
// INR 500.00 on Jul 18, 2026 at 06:03:26. Info: AMAZON PAY INDIA PVT LTD."
const TRANSACTION_PATTERN =
  /Your ICICI Bank Credit Card\s+(?:XX)?(\d{4})\s+has been used for a transaction of\s+([A-Z]{3})\s*([\d,]+(?:\.\d{1,2})?)\s+on\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\.\s*Info:\s*(.+?)\.\s*(?:The Available Credit Limit|$)/is;

export function parseIciciCreditCard(email: EmailContent): ParsedFields | null {
  if (!email.subject.includes(SUBJECT)) return null;
  if (/\bdeclined\b/i.test(email.body)) return null;

  const match = email.body.match(TRANSACTION_PATTERN);
  if (!match) return null;

  const [
    ,
    last4,
    currencyRaw,
    amountRaw,
    monthRaw,
    dayRaw,
    yearRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
    merchantRaw,
  ] = match;
  const month = MONTHS[monthRaw.toLowerCase()];
  if (month === undefined) return null;

  const amount = Number(amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  const datetime = buildIstDatetime(
    Number(yearRaw),
    month,
    Number(dayRaw),
    Number(hourRaw),
    Number(minuteRaw),
    Number(secondRaw),
    email.receivedAt
  );
  if (!datetime) return null;

  const currency = currencyRaw.toUpperCase();
  const isInternational = currency !== "INR";
  return {
    source: "icici_cc",
    amount,
    merchant_raw: merchantRaw.trim(),
    datetime,
    card_last4: last4,
    is_reversal: false,
    currency,
    amount_inr: null,
    is_international: isInternational,
    notes: isInternational ? "pending_forex_resolution" : null,
    envelope_impact: isInternational ? 0 : null,
    is_preauth: false,
    direction: "debit",
  };
}

function buildIstDatetime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  receivedAt?: string
): string | null {
  const candidateHours = hour <= 12 ? Array.from(new Set([hour % 12, (hour % 12) + 12])) : [hour];
  const candidates = candidateHours
    .map((candidateHour) => {
      const isoWithOffset = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(
        2,
        "0"
      )}T${String(candidateHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
        second
      ).padStart(2, "0")}+05:30`;
      return new Date(isoWithOffset);
    })
    .filter((candidate) => !Number.isNaN(candidate.getTime()));
  if (candidates.length === 0) return null;

  const received = receivedAt ? new Date(receivedAt) : null;
  if (!received || Number.isNaN(received.getTime())) return candidates[0].toISOString();
  candidates.sort(
    (left, right) =>
      Math.abs(left.getTime() - received.getTime()) - Math.abs(right.getTime() - received.getTime())
  );
  return candidates[0].toISOString();
}
