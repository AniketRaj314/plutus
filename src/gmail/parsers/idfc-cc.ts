import type { EmailContent, ParsedFields } from "./types";

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

// Format 1: "Alert: Your IDFC FIRST Credit Card"
// "INR 299.00 spent on your IDFC FIRST Bank Credit Card ending XX6198 at
//  YOUTUBEGOOGLE on 06-JUL-2026 at 12:29 PM"
const ALERT_PATTERN =
  /INR\s*([\d,]+\.\d{2})\s*spent on your IDFC FIRST Bank Credit Card ending\s*(?:XX)?(\d{4})\s*at\s*(.+?)\s*on\s*(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{4})\s*at\s*(\d{1,2}:\d{2}\s*[AP]M)/i;

// Format 2: "Debit Alert: Your IDFC FIRST Bank Credit Card"
// "INR 282.00 spent on your IDFC FIRST BANK Credit Card ending XX6198 at
//  SWIGGY on 26 MAY 2026."  (date only, no time; greeting line before the
//  amount varies — "Transaction Successful!", "Happy Shopping!", etc.)
const DEBIT_ALERT_PATTERN =
  /INR\s*([\d,]+\.\d{2})\s*spent on your IDFC FIRST BANK Credit Card ending\s*(?:XX)?(\d{4})\s*at\s*(.+?)\s*on\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\.?/i;

// Format 3: "Transaction reversal!"
// "Transaction of INR 525.50 made at on 27-05-2026 has been refunded to
//  your IDFC FIRST Bank Credit Card ending XX6198." (merchant omitted by IDFC)
const REVERSAL_PATTERN =
  /Transaction of INR\s*([\d,]+\.\d{2})\s*made at on\s*(\d{2})-(\d{2})-(\d{4})\s*has been refunded to your IDFC FIRST Bank Credit Card ending\s*(?:XX)?(\d{4})/i;

export function parseIdfcCreditCard(email: EmailContent): ParsedFields | null {
  if (email.subject.includes("Transaction reversal")) {
    return parseReversal(email);
  }

  if (email.subject.includes("Debit Alert: Your IDFC FIRST Bank Credit Card")) {
    return parseDebitAlert(email);
  }

  if (email.subject.includes("Alert: Your IDFC FIRST Credit Card")) {
    return parseAlert(email);
  }

  return null;
}

function parseAlert(email: EmailContent): ParsedFields | null {
  const match = email.body.match(ALERT_PATTERN);
  if (!match) return null;

  const [, amountStr, last4, merchantRaw, dayStr, monthStr, yearStr, timeStr] = match;
  const month = MONTHS[monthStr.toLowerCase()];
  if (month === undefined) return null;

  const datetime = buildIsoDatetime(Number(dayStr), month, Number(yearStr), timeStr);
  if (!datetime) return null;

  return {
    source: "idfc_cc",
    amount: Number(amountStr.replace(/,/g, "")),
    merchant_raw: merchantRaw.trim(),
    datetime,
    card_last4: last4,
    is_reversal: false,
    currency: "INR",
    amount_inr: null,
    is_international: false,
    notes: null,
    envelope_impact: null,
    is_preauth: false,
    direction: "debit",
  };
}

function parseDebitAlert(email: EmailContent): ParsedFields | null {
  const match = email.body.match(DEBIT_ALERT_PATTERN);
  if (!match) return null;

  const [, amountStr, last4, merchantRaw, dayStr, monthStr, yearStr] = match;
  const month = MONTHS[monthStr.toLowerCase()];
  if (month === undefined) return null;

  const datetime = buildIsoDatetime(Number(dayStr), month, Number(yearStr), "12:00 AM");
  if (!datetime) return null;

  return {
    source: "idfc_cc",
    amount: Number(amountStr.replace(/,/g, "")),
    merchant_raw: merchantRaw.trim(),
    datetime,
    card_last4: last4,
    is_reversal: false,
    currency: "INR",
    amount_inr: null,
    is_international: false,
    notes: null,
    envelope_impact: null,
    is_preauth: false,
    direction: "debit",
  };
}

function parseReversal(email: EmailContent): ParsedFields | null {
  const match = email.body.match(REVERSAL_PATTERN);
  if (!match) return null;

  const [, amountStr, dayStr, monthStr, yearStr, last4] = match;

  const isoWithOffset = `${yearStr}-${monthStr}-${dayStr}T00:00:00+05:30`;
  const parsed = new Date(isoWithOffset);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    source: "idfc_cc",
    amount: Number(amountStr.replace(/,/g, "")),
    merchant_raw: null,
    datetime: parsed.toISOString(),
    card_last4: last4,
    is_reversal: true,
    currency: "INR",
    amount_inr: null,
    is_international: false,
    notes: null,
    envelope_impact: null,
    is_preauth: false,
    direction: "credit",
  };
}

function buildIsoDatetime(day: number, month: number, year: number, time12h: string): string | null {
  const timeMatch = time12h.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toUpperCase();

  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const min = String(minute).padStart(2, "0");

  const isoWithOffset = `${year}-${mm}-${dd}T${hh}:${min}:00+05:30`;
  const parsed = new Date(isoWithOffset);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
