import cron from "node-cron";
import type Database from "better-sqlite3";
import {
  getEnvelope,
  updateEnvelope,
  listCommittedExpenses,
  listTransactions,
  updateTransaction,
  listCreditCards,
  type Envelope,
  type Transaction,
  type CreditCard,
} from "../db/queries";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_MONTHLY_SPENDABLE = 120000;
const DEFAULT_SALARY_DAY = 1;
export const BIG_PURCHASE_THRESHOLD = 3000;
const CC_PAYMENT_PATTERNS = ["AMEX", "AMERICAN EXPRESS", "BOBCARD", "ONECARD", "ICICI CREDIT", "IDFC CREDIT"];
// Merchant text must look bill-payment-shaped before the amount-matching
// heuristic below is trusted — coincidental amount sums are common at
// personal-finance transaction volumes.
const AMOUNT_HEURISTIC_GATE_PATTERNS = [
  "BILL",
  "PAYMENT",
  "DUE",
  "OUTSTANDING",
  "AMEX",
  "BOBCARD",
  "ONECARD",
  "ICICI",
  "IDFC",
];

export interface ApplyTransactionResult {
  week_remaining: number;
  month_remaining: number;
  triggered_rebalance: RebalanceResult | null;
}

export interface RebalanceResult {
  new_weekly_budget: number;
  weeks_remaining: number;
  message: string;
}

export interface RolloverResult {
  carried_forward: number;
  new_week_budget: number;
}

// -- date helpers (weeks run Monday-Sunday, anchored to IST since all
// parsed transaction timestamps are IST bank alerts) --

function toIstDateOnly(d: Date): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function formatIstDate(dateOnly: Date): string {
  return dateOnly.toISOString().slice(0, 10);
}

export function parseIstDateOnly(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function getWeekStart(referenceDate: Date): Date {
  const dateOnly = toIstDateOnly(referenceDate);
  const day = dateOnly.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  dateOnly.setUTCDate(dateOnly.getUTCDate() + diff);
  return dateOnly;
}

function getMonthEnd(monthStr: string): Date {
  const [year, month] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0));
}

export function getRemainingWeeksInMonth(weekStart: Date, monthStr: string): number {
  const monthEnd = getMonthEnd(monthStr);
  let count = 0;
  let cursor = new Date(weekStart);
  while (cursor.getTime() <= monthEnd.getTime()) {
    count++;
    cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return Math.max(count, 1);
}

// -- setup --

export function setupEnvelope(
  db: Database.Database,
  opts?: { monthlySpendable?: number; salaryDay?: number }
): Envelope {
  const monthlySpendable = opts?.monthlySpendable ?? DEFAULT_MONTHLY_SPENDABLE;
  const salaryDay = opts?.salaryDay ?? DEFAULT_SALARY_DAY;

  const committed = listCommittedExpenses(db);
  const committedTotal = committed.reduce((sum, c) => sum + (c.amount_approx ?? 0), 0);
  const discretionaryPool = monthlySpendable - committedTotal;

  const now = new Date();
  const month = formatIstDate(toIstDateOnly(now)).slice(0, 7);
  const weekStart = getWeekStart(now);
  const weeksRemaining = getRemainingWeeksInMonth(weekStart, month);
  const weeklyBudget = discretionaryPool / weeksRemaining;

  updateEnvelope(db, {
    month,
    salary_day: salaryDay,
    monthly_spendable: monthlySpendable,
    committed_total: committedTotal,
    discretionary_pool: discretionaryPool,
    spent_discretionary: 0,
    current_week_start: formatIstDate(weekStart),
    current_week_budget: weeklyBudget,
    current_week_spent: 0,
  });

  console.log(
    `[envelope] setup complete: monthly_spendable=${monthlySpendable} committed_total=${committedTotal} discretionary_pool=${discretionaryPool} weeks_remaining=${weeksRemaining} current_week_budget=${weeklyBudget}`
  );

  return getEnvelope(db) as Envelope;
}

// Mid-month recompute of committed_total/discretionary_pool/current_week_budget
// (e.g. after adding a new committed expense) WITHOUT resetting spent_discretionary
// or current_week_spent — unlike setupEnvelope, which is for first-run bootstrap
// and month rollover, where zeroing spend tracking is correct. Calling
// setupEnvelope mid-month would silently wipe already-tracked spending.
export function recalculateEnvelope(db: Database.Database): Envelope {
  const envelope = getEnvelope(db);
  if (!envelope || !envelope.monthly_spendable) {
    return setupEnvelope(db);
  }

  const committed = listCommittedExpenses(db);
  const committedTotal = committed.reduce((sum, c) => sum + (c.amount_approx ?? 0), 0);
  const monthlySpendable = envelope.monthly_spendable ?? 0;
  const discretionaryPool = monthlySpendable - committedTotal;

  const now = new Date();
  const weekStart = envelope.current_week_start ? parseIstDateOnly(envelope.current_week_start) : getWeekStart(now);
  const month = envelope.month ?? formatIstDate(toIstDateOnly(now)).slice(0, 7);
  const weeksRemaining = getRemainingWeeksInMonth(weekStart, month);

  const remainingPool = discretionaryPool - (envelope.spent_discretionary ?? 0);
  const newWeeklyBudget = remainingPool / weeksRemaining;

  updateEnvelope(db, {
    committed_total: committedTotal,
    discretionary_pool: discretionaryPool,
    current_week_budget: newWeeklyBudget,
  });

  console.log(
    `[envelope] recalculated (spend tracking preserved): committed_total=${committedTotal} discretionary_pool=${discretionaryPool} current_week_budget=${newWeeklyBudget}`
  );

  return getEnvelope(db) as Envelope;
}

// Full reconciliation of spend tracking against actual transaction data —
// distinct from recalculateEnvelope() above, which only rederives
// committed_total/discretionary_pool/current_week_budget from committed
// expenses and assumes spent_discretionary/current_week_spent are already
// correct. Use this after a bulk backfill or any batch of manual
// create/delete_transaction calls, where incremental application could have
// drifted from reality (out-of-order inserts, deleted rows, etc).
export function reconcileEnvelopeFromTransactions(db: Database.Database): Envelope {
  const envelope = getEnvelope(db);
  if (!envelope || !envelope.monthly_spendable) {
    return setupEnvelope(db);
  }

  const monthStart = `${envelope.month}-01T00:00:00.000Z`;
  const weekStart = `${envelope.current_week_start}T00:00:00.000Z`;

  // Reversals are intentionally included, not excluded — their envelope_impact
  // is already negative, so summing them nets refunds against the original
  // charge instead of silently ignoring the credit.
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN datetime >= @monthStart THEN envelope_impact ELSE 0 END), 0) AS month_total,
         COALESCE(SUM(CASE WHEN datetime >= @weekStart THEN envelope_impact ELSE 0 END), 0) AS week_total
       FROM transactions
       WHERE is_committed = 0 AND is_cancelled_out = 0 AND envelope_applied = 1`
    )
    .get({ monthStart, weekStart }) as { month_total: number; week_total: number };

  const weekStartDate = envelope.current_week_start ? parseIstDateOnly(envelope.current_week_start) : getWeekStart(new Date());
  const month = envelope.month ?? formatIstDate(toIstDateOnly(new Date())).slice(0, 7);
  const weeksRemaining = getRemainingWeeksInMonth(weekStartDate, month);

  const discretionaryPool = envelope.discretionary_pool ?? 0;
  const remainingPool = discretionaryPool - row.month_total;
  const newWeeklyBudget = remainingPool / weeksRemaining;

  updateEnvelope(db, {
    spent_discretionary: row.month_total,
    current_week_spent: row.week_total,
    current_week_budget: newWeeklyBudget,
  });

  console.log(
    `[envelope] reconciled from transactions: spent_discretionary=${row.month_total} current_week_spent=${row.week_total} current_week_budget=${newWeeklyBudget}`
  );

  return getEnvelope(db) as Envelope;
}

// -- core operations --

export function getEnvelopeState(db: Database.Database): Envelope | undefined {
  return getEnvelope(db);
}

export function getBillingWindow(card: CreditCard, referenceDate: Date): { start: string; end: string } {
  const cycle = getCardCycleForDate(card, referenceDate);
  return { start: cycle.start, end: cycle.end };
}

export interface CardCycle {
  start: string;
  end: string;
  due_date: string;
  funding_month: string;
}

export function getSalaryFundingMonthForDate(referenceDate: Date, salaryDay: number): string {
  if (!Number.isInteger(salaryDay) || salaryDay < 1 || salaryDay > 31) {
    throw new Error("salaryDay must be an integer between 1 and 31");
  }
  const ref = toIstDateOnly(referenceDate);
  const lastDayOfMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).getUTCDate();
  const effectiveSalaryDay = Math.min(salaryDay, lastDayOfMonth);
  const fundingDate = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - (ref.getUTCDate() < effectiveSalaryDay ? 1 : 0), 1)
  );
  return formatIstDate(fundingDate).slice(0, 7);
}

// Pure date routing helper. It does not decide financial meaning; it only
// answers which configured statement cycle contains a transaction and which
// salary month contains that cycle's due date.
export function getCardCycleForDate(card: CreditCard, referenceDate: Date): CardCycle {
  const ref = toIstDateOnly(referenceDate);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth();
  const day = ref.getUTCDate();
  const startDay = card.billing_start_day ?? 1;
  const endDay = card.billing_end_day ?? 28;
  const dueDay = card.due_day ?? 1;

  // Cycles cross a month boundary for every configured card. Before the
  // start day, the transaction belongs to the cycle that began last month;
  // on/after the start day, it belongs to the newly-opened cycle.
  const startsThisMonth = day >= startDay;
  const start = new Date(Date.UTC(year, startsThisMonth ? month : month - 1, startDay));
  const end = new Date(Date.UTC(year, startsThisMonth ? month + 1 : month, endDay));

  // All current cards are due early in the month after statement close. The
  // conditional also supports a future card whose due day is later in the
  // same month as its cycle end.
  const dueMonthOffset = dueDay <= endDay ? 1 : 0;
  const due = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + dueMonthOffset, dueDay));

  return {
    start: formatIstDate(start),
    end: formatIstDate(end),
    due_date: formatIstDate(due),
    funding_month: formatIstDate(due).slice(0, 7),
  };
}

export function isCreditCardPayment(db: Database.Database, transaction: Transaction): boolean {
  const merchantText = `${transaction.merchant_raw ?? ""} ${transaction.merchant_clean ?? ""}`.toUpperCase();
  if (CC_PAYMENT_PATTERNS.some((pattern) => merchantText.includes(pattern))) {
    return true;
  }

  if (!transaction.amount) return false;

  const looksBillPaymentShaped = AMOUNT_HEURISTIC_GATE_PATTERNS.some((pattern) => merchantText.includes(pattern));
  if (!looksBillPaymentShaped) return false;

  const referenceDate = transaction.datetime ? new Date(transaction.datetime) : new Date();
  const cards = listCreditCards(db).filter((c) => c.last4);
  const allTransactions = listTransactions(db, 500);

  for (const card of cards) {
    const window = getBillingWindow(card, referenceDate);

    const windowSpend = allTransactions
      .filter(
        (t) =>
          t.id !== transaction.id &&
          t.card_last4 === card.last4 &&
          !t.is_credit_card_payment &&
          !t.is_reversal &&
          t.datetime &&
          t.datetime.slice(0, 10) >= window.start &&
          t.datetime.slice(0, 10) <= window.end
      )
      .reduce((sum, t) => sum + (t.amount ?? 0), 0);

    if (windowSpend === 0) continue;

    const tolerance = windowSpend * 0.05;
    if (Math.abs(windowSpend - transaction.amount) <= tolerance) {
      return true;
    }
  }

  return false;
}

export function applyTransaction(db: Database.Database, transaction: Transaction): ApplyTransactionResult | null {
  if (transaction.envelope_applied) {
    const current = getEnvelope(db);
    console.log(`[envelope] transaction ${transaction.id} already applied, returning current state without re-deducting`);
    return {
      week_remaining: (current?.current_week_budget ?? 0) - (current?.current_week_spent ?? 0),
      month_remaining: (current?.discretionary_pool ?? 0) - (current?.spent_discretionary ?? 0),
      triggered_rebalance: null,
    };
  }

  if (transaction.is_committed || transaction.is_cancelled_out || transaction.is_credit_card_payment) {
    return null;
  }

  if (isCreditCardPayment(db, transaction)) {
    updateTransaction(db, transaction.id, { is_credit_card_payment: 1 });
    return null;
  }

  let envelope = getEnvelope(db);
  if (!envelope || !envelope.monthly_spendable) {
    envelope = setupEnvelope(db);
  }

  const magnitude = transaction.envelope_impact ?? transaction.amount ?? 0;
  const signedAmount = transaction.is_reversal ? -magnitude : magnitude;

  const newWeekSpent = (envelope.current_week_spent ?? 0) + signedAmount;
  const newSpentDiscretionary = (envelope.spent_discretionary ?? 0) + signedAmount;

  updateEnvelope(db, {
    current_week_spent: newWeekSpent,
    spent_discretionary: newSpentDiscretionary,
  });

  updateTransaction(db, transaction.id, { envelope_applied: 1, envelope_impact: signedAmount });

  const triggeredRebalance = transaction.is_reversal ? null : rebalanceAfterBigPurchase(db, magnitude);

  // Re-read after a possible rebalance so week_remaining reflects the
  // post-rebalance current_week_budget, not the stale pre-rebalance value.
  const finalEnvelope = triggeredRebalance ? getEnvelope(db) : envelope;
  const weekRemaining = (finalEnvelope?.current_week_budget ?? envelope.current_week_budget ?? 0) - newWeekSpent;
  const monthRemaining = (envelope.discretionary_pool ?? 0) - newSpentDiscretionary;

  return {
    week_remaining: weekRemaining,
    month_remaining: monthRemaining,
    triggered_rebalance: triggeredRebalance,
  };
}

export function rebalanceAfterBigPurchase(
  db: Database.Database,
  amount: number,
  threshold = BIG_PURCHASE_THRESHOLD
): RebalanceResult | null {
  if (amount <= threshold) return null;

  const envelope = getEnvelope(db);
  if (!envelope) return null;

  const now = new Date();
  const weekStart = envelope.current_week_start ? parseIstDateOnly(envelope.current_week_start) : getWeekStart(now);
  const month = envelope.month ?? formatIstDate(toIstDateOnly(now)).slice(0, 7);
  const weeksRemaining = getRemainingWeeksInMonth(weekStart, month);

  const remainingPool = (envelope.discretionary_pool ?? 0) - (envelope.spent_discretionary ?? 0);
  const newWeeklyBudget = remainingPool / weeksRemaining;

  updateEnvelope(db, { current_week_budget: newWeeklyBudget });

  const message = `Big purchase detected: ₹${amount.toFixed(2)}. Weekly budget rebalanced to ₹${newWeeklyBudget.toFixed(2)} for the remaining ${weeksRemaining} week(s) this month.`;

  return { new_weekly_budget: newWeeklyBudget, weeks_remaining: weeksRemaining, message };
}

export function rolloverWeek(db: Database.Database): RolloverResult {
  let envelope = getEnvelope(db);
  if (!envelope || !envelope.monthly_spendable) {
    envelope = setupEnvelope(db);
  }

  const carriedForward = (envelope.current_week_budget ?? 0) - (envelope.current_week_spent ?? 0);

  const now = new Date();
  const newWeekStart = getWeekStart(now);
  const todayIstMonth = formatIstDate(toIstDateOnly(now)).slice(0, 7);

  if (envelope.month !== todayIstMonth) {
    const fresh = setupEnvelope(db, {
      monthlySpendable: envelope.monthly_spendable ?? undefined,
      salaryDay: envelope.salary_day ?? undefined,
    });
    console.log("[envelope] rollover crossed into a new calendar month, ran a fresh monthly setup instead of carrying forward");
    return { carried_forward: 0, new_week_budget: fresh.current_week_budget ?? 0 };
  }

  // "Carry forward" is achieved by re-dividing what's actually left in the
  // pool (discretionary_pool - spent_discretionary) across the remaining
  // weeks, rather than adding carriedForward on top of that — spent_discretionary
  // already reflects true spend, so an underspent week automatically inflates
  // the pool available to future weeks. Adding it again would double-count it.
  const weeksRemaining = getRemainingWeeksInMonth(newWeekStart, envelope.month ?? todayIstMonth);
  const remainingPool = (envelope.discretionary_pool ?? 0) - (envelope.spent_discretionary ?? 0);
  const newWeekBudget = remainingPool / weeksRemaining;

  updateEnvelope(db, {
    current_week_start: formatIstDate(newWeekStart),
    current_week_budget: newWeekBudget,
    current_week_spent: 0,
  });

  console.log(
    `[envelope] week rollover: carried_forward=${carriedForward.toFixed(2)} new_week_budget=${newWeekBudget.toFixed(2)} weeks_remaining=${weeksRemaining}`
  );

  return { carried_forward: carriedForward, new_week_budget: newWeekBudget };
}

// -- cron --

export function startEnvelopeCron(db: Database.Database): void {
  cron.schedule("0 0 * * *", () => {
    checkAndRolloverIfNeeded(db);
  });
  console.log("Envelope rollover check scheduled daily at midnight");
}

function checkAndRolloverIfNeeded(db: Database.Database): void {
  try {
    const envelope = getEnvelope(db);
    if (!envelope || !envelope.monthly_spendable) return;

    const currentWeekStart = formatIstDate(getWeekStart(new Date()));
    if (envelope.current_week_start !== currentWeekStart) {
      rolloverWeek(db);
    }
  } catch (err) {
    console.error("[envelope] daily rollover check failed:", err);
  }
}
