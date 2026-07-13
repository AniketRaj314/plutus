import type { EmailContent, ParsedFields } from "./types";

// Real email format not yet confirmed (IDFC UPI/savings alerts are being
// enabled on the account). This list and the regexes below are best-guess,
// modelled on the confirmed IDFC CC formats — adjust freely once a real
// email arrives. The one behavior that must NOT change regardless of format
// tweaks: correlation_status starts as 'pending' on every insert.
const SUBJECT_VARIANTS = [
  "Alert: Your IDFC FIRST Bank Account",
  "Debit Alert: Your IDFC FIRST Bank Account",
  "UPI Transaction Alert",
];

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

// "INR 500.00 debited from your IDFC FIRST Bank Account ending 1234 via UPI
//  on 13-JUL-2026 at 09:15 AM. UPI Ref: 123456789012. VPA: merchant@upi"
const TRANSACTION_PATTERN =
  /INR\s*([\d,]+\.\d{2})\s*debited from your IDFC FIRST Bank Account ending\s*(?:XX)?(\d{4})\s*via UPI\s*on\s*(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{4})\s*at\s*(\d{1,2}:\d{2}\s*[AP]M)/i;

const UPI_REF_PATTERN = /UPI\s*Ref:?\s*([\w-]+)/i;
const VPA_PATTERN = /VPA:?\s*([\w.\-]+@[\w.\-]+)/i;

export function parseIdfcUpi(email: EmailContent): ParsedFields | null {
  if (!SUBJECT_VARIANTS.some((subject) => email.subject.includes(subject))) {
    console.log("IDFC UPI: subject did not match any known variant, skipping");
    return null;
  }

  const match = email.body.match(TRANSACTION_PATTERN);
  if (!match) {
    console.log("IDFC UPI: subject matched but body pattern did not — email format may have changed");
    return null;
  }

  const [, amountStr, accountLast4, dayStr, monthStr, yearStr, timeStr] = match;
  const month = MONTHS[monthStr.toLowerCase()];
  if (month === undefined) return null;

  const datetime = buildIsoDatetime(Number(dayStr), month, Number(yearStr), timeStr);
  if (!datetime) return null;

  const amount = Number(amountStr.replace(/,/g, ""));
  const vpaMatch = email.body.match(VPA_PATTERN);
  const vpa = vpaMatch ? vpaMatch[1] : null;
  const upiRefMatch = email.body.match(UPI_REF_PATTERN);
  const upiRef = upiRefMatch ? upiRefMatch[1] : null;

  return {
    source: "idfc_upi",
    amount,
    merchant_raw: vpa ?? "UPI Transfer",
    datetime,
    card_last4: accountLast4,
    is_reversal: false,
    currency: "INR",
    amount_inr: amount,
    is_international: false,
    envelope_impact: null,
    notes: upiRef ? `upi_ref:${upiRef}` : null,
    is_preauth: false,
    correlation_status: "pending",
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
