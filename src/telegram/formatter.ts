import type { Transaction, Envelope } from "../db/queries";
import type { EnvelopeEntry } from "../db/v2-queries";
import { getRemainingWeeksInMonth, parseIstDateOnly, BIG_PURCHASE_THRESHOLD } from "../envelope/engine";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Card display names are hardcoded here (rather than looked up from the
// credit_cards table) since formatTransaction takes no db param by design.
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  idfc_cc: "IDFC CC",
  bobcard: "BOBCARD One",
  amex: "AmEx",
  idfc_upi: "IDFC UPI",
};

export function formatINR(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(amount))}`;
}

export function formatIstDateTime(isoUtc: string): string {
  const d = new Date(isoUtc);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const day = String(ist.getUTCDate()).padStart(2, "0");
  const month = MONTH_ABBR[ist.getUTCMonth()];
  let hour = ist.getUTCHours();
  const minute = String(ist.getUTCMinutes()).padStart(2, "0");
  const meridiem = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${day} ${month}, ${hour}:${minute} ${meridiem}`;
}

function sourceLabel(source: string | null): string {
  return SOURCE_DISPLAY_NAMES[source ?? ""] ?? source ?? "Card";
}

function weekRemainingLine(envelope: Envelope | undefined): string | null {
  if (!envelope) return null;
  const remaining = (envelope.current_week_budget ?? 0) - (envelope.current_week_spent ?? 0);
  return `📊 Week: ${formatINR(remaining)} remaining`;
}

export function formatTransaction(transaction: Transaction, envelope: Envelope | undefined): string | null {
  if (transaction.is_committed) return null;

  const dateLine = `📅 ${formatIstDateTime(transaction.datetime ?? new Date().toISOString())}`;

  if (transaction.correlation_status === "pending") {
    return [`🔄 UPI Transfer · IDFC`, `${formatINR(transaction.amount ?? 0)} · Matching receipt...`, dateLine].join(
      "\n"
    );
  }

  if (transaction.correlation_status === "matched") {
    const lines = [
      `🚗 ${transaction.merchant_clean ?? "Merchant"} (via UPI)`,
      `${formatINR(transaction.amount ?? 0)}${transaction.category ? ` · ${transaction.category}` : ""}`,
      dateLine,
    ];
    const week = weekRemainingLine(envelope);
    if (week) lines.push(week);
    return lines.join("\n");
  }

  // Reversal (refund) — not in the original examples, but is_reversal is a
  // real state the parsers/envelope engine already produce, so it needs
  // *some* sane rendering rather than falling through to the standard format.
  if (transaction.is_reversal) {
    const lines = [
      `↩️ Refund · ${sourceLabel(transaction.source)}`,
      `${formatINR(transaction.amount ?? 0)} returned`,
      dateLine,
    ];
    const week = weekRemainingLine(envelope);
    if (week) lines.push(week);
    return lines.join("\n");
  }

  if (transaction.is_international) {
    return [
      `🌏 ${sourceLabel(transaction.source)}`,
      `${transaction.currency} ${transaction.amount} · ${transaction.merchant_raw ?? "Unknown"}`,
      dateLine,
      `⏳ INR amount pending forex conversion`,
    ].join("\n");
  }

  const header = `💳 ${sourceLabel(transaction.source)}`;
  const merchantLine = `${formatINR(transaction.amount ?? 0)} · ${transaction.merchant_clean ?? transaction.merchant_raw ?? "Unknown"}`;

  const magnitude = transaction.envelope_impact ?? transaction.amount ?? 0;
  if (magnitude > BIG_PURCHASE_THRESHOLD && envelope) {
    const weekStart = envelope.current_week_start ? parseIstDateOnly(envelope.current_week_start) : new Date();
    const weeksRemaining = getRemainingWeeksInMonth(weekStart, envelope.month ?? weekStart.toISOString().slice(0, 7));
    return [
      header,
      merchantLine,
      dateLine,
      `⚠️ Weekly adjusted: ${formatINR(envelope.current_week_budget ?? 0)} for ${weeksRemaining} remaining weeks`,
    ].join("\n");
  }

  const lines = [header, merchantLine, dateLine];
  const week = weekRemainingLine(envelope);
  if (week) lines.push(week);
  return lines.join("\n");
}

export interface V2TransactionPresentation {
  status: "interpreted" | "already_interpreted" | "needs_context" | "failed" | "correlating";
  entry?: EnvelopeEntry;
  spend_month?: string;
  spend_month_remaining?: number;
  question?: string;
}

function spendMonthLabel(spendMonth: string): string {
  const [year, month] = spendMonth.split("-").map(Number);
  if (!year || month < 1 || month > 12) return spendMonth;
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function formatV2Transaction(
  transaction: Transaction,
  presentation: V2TransactionPresentation
): string {
  const dateLine = `📅 ${formatIstDateTime(transaction.datetime ?? new Date().toISOString())}`;
  if (presentation.status === "correlating") {
    return [
      `🔄 UPI Transfer · IDFC`,
      `${formatINR(transaction.amount ?? 0)} · Matching receipt...`,
      dateLine,
    ].join("\n");
  }

  const amount = transaction.is_international
    ? transaction.amount_inr ?? transaction.amount ?? 0
    : transaction.amount ?? 0;
  const merchant = transaction.merchant_clean ?? transaction.merchant_raw ?? "Unknown";
  const header = transaction.is_reversal
    ? `↩️ Refund · ${sourceLabel(transaction.source)}`
    : transaction.source === "idfc_upi"
    ? `💸 UPI · IDFC`
    : `💳 ${sourceLabel(transaction.source)}`;
  const amountLine = transaction.is_international && transaction.amount_inr === null
    ? `${transaction.currency} ${transaction.amount} · ${merchant}`
    : `${formatINR(amount)} · ${merchant}`;
  const lines = [header, amountLine, dateLine];

  if (presentation.entry) {
    const entry = presentation.entry;
    lines.push(`🧾 ${entry.treatment} · Personal ${formatINR(entry.personal_impact)}`);
    if (entry.cashflow_impact !== entry.personal_impact) {
      lines.push(`💵 Cash needed ${formatINR(entry.cashflow_impact)}`);
    }
    if (entry.receivable_amount > 0) {
      lines.push(`↩️ Expected back ${formatINR(entry.receivable_amount)}`);
    }
    if (presentation.spend_month && presentation.spend_month_remaining !== undefined) {
      const label = spendMonthLabel(presentation.spend_month);
      const remaining = presentation.spend_month_remaining;
      lines.push(
        remaining < 0
          ? `📊 ${label} spending envelope: ${formatINR(Math.abs(remaining))} over`
          : `📊 ${label} spending envelope: ${formatINR(remaining)} remaining`
      );
    }
  } else if (presentation.status === "needs_context") {
    lines.push(`🤔 ${presentation.question ?? "I need context before counting this."}`);
  } else {
    lines.push("⏳ Saved, but automatic interpretation is pending");
  }

  lines.push("Reply to correct or add context");
  return lines.join("\n");
}

export function formatEnvelopeSummary(envelope: Envelope | undefined): string {
  if (!envelope) return "📊 Plutus · Week Summary\nNo envelope configured yet.";

  const weekSpent = envelope.current_week_spent ?? 0;
  const weekRemaining = (envelope.current_week_budget ?? 0) - weekSpent;
  const monthSpent = envelope.spent_discretionary ?? 0;
  const monthPool = envelope.discretionary_pool ?? 0;

  const today = new Date(Date.now() + IST_OFFSET_MS);
  const month = envelope.month ?? `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const [year, monthNum] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, monthNum, 0));
  const todayDateOnly = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const daysUntilReset = Math.max(
    1,
    Math.round((monthEnd.getTime() - todayDateOnly.getTime()) / (24 * 60 * 60 * 1000)) + 1
  );

  return [
    "📊 Plutus · Week Summary",
    `Spent: ${formatINR(weekSpent)}`,
    `Remaining: ${formatINR(weekRemaining)}`,
    `Month: ${formatINR(monthSpent)} of ${formatINR(monthPool)} used`,
    `Resets in ${daysUntilReset} days`,
  ].join("\n");
}
