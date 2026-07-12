import type Database from "better-sqlite3";
import {
  getEnvelope,
  listCreditCards,
  listCommittedExpenses,
  listAllSplits,
  queryTransactions,
  listContext,
  type Split,
} from "../db/queries";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIst(): Date {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function daysUntilSalaryDay(salaryDay: number | null): number {
  if (!salaryDay) return 0;
  const today = todayIst();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  let next = new Date(Date.UTC(year, month, salaryDay));
  if (next.getTime() <= today.getTime()) {
    next = new Date(Date.UTC(year, month + 1, salaryDay));
  }

  return Math.round((next.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function formatDateIst(isoUtc: string): string {
  const d = new Date(new Date(isoUtc).getTime() + IST_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
}

export function buildSystemPrompt(db: Database.Database): string {
  const envelope = getEnvelope(db);
  const cards = listCreditCards(db);
  const committed = listCommittedExpenses(db);
  const splits = listAllSplits(db);

  const weekRemaining = (envelope?.current_week_budget ?? 0) - (envelope?.current_week_spent ?? 0);

  const cardLines = cards
    .filter((c) => c.billing_start_day && c.billing_end_day && c.due_day)
    .map(
      (c) =>
        `- ${c.name}: ${ordinal(c.billing_start_day as number)} → ${ordinal(c.billing_end_day as number)}, due ${ordinal(c.due_day as number)}`
    )
    .join("\n");

  const committedLines =
    committed.length > 0
      ? committed
          .map((c) => `- ${c.label} · ₹${c.amount_approx ?? 0} · ${c.merchant_pattern ?? c.vpa ?? "(no pattern)"}`)
          .join("\n")
      : "(none defined)";

  const openSplitsLines = buildOpenSplitsSection(db, splits);

  const internationalPending = queryTransactions(db, { limit: 500 }).filter(
    (t) => t.is_international && t.amount_inr === null
  );
  const internationalLines =
    internationalPending.length > 0
      ? internationalPending
          .map(
            (t) =>
              `- ${t.merchant_clean ?? t.merchant_raw ?? "Unknown"} · ${t.currency} ${t.amount} · ${t.datetime ? formatDateIst(t.datetime) : "unknown date"}`
          )
          .join("\n")
      : "(none)";

  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lowConfidence = queryTransactions(db, { since: sevenDaysAgoIso, limit: 500 }).filter(
    (t) => t.notes === "enrichment_failed" || (t.enrichment_confidence !== null && t.enrichment_confidence < 0.7)
  );
  const lowConfidenceLines =
    lowConfidence.length > 0
      ? lowConfidence
          .map((t) => `- ${t.merchant_raw ?? "Unknown"} · ₹${t.amount ?? 0} · currently: ${t.category ?? "uncategorized"}`)
          .join("\n")
      : "(none)";

  const context = listContext(db).filter(
    (row) => row.key !== "telegram_message_map" && row.key !== "processed_message_ids"
  );
  const contextLines =
    context.length > 0 ? context.map((row) => `- ${row.key}: ${row.value}`).join("\n") : "(none)";

  return `You are Plutus, Aniket's personal finance agent. You are concise, direct, and slightly witty. You communicate primarily via Telegram so keep responses short and punchy unless the user explicitly asks for detail. Use ₹ for Indian Rupee amounts.

TODAY: ${todayIst().toISOString().slice(0, 10)} (IST)

FINANCIAL STATE:
- Monthly spendable: ₹${envelope?.monthly_spendable ?? 0}
- Committed this month: ₹${envelope?.committed_total ?? 0}
- Discretionary pool: ₹${envelope?.discretionary_pool ?? 0}
- Spent discretionary so far: ₹${envelope?.spent_discretionary ?? 0}
- Week budget: ₹${envelope?.current_week_budget ?? 0}
- Week spent: ₹${envelope?.current_week_spent ?? 0}
- Week remaining: ₹${weekRemaining}
- Month resets: ${daysUntilSalaryDay(envelope?.salary_day ?? null)} days

CREDIT CARD BILLING WINDOWS:
${cardLines || "(none configured)"}
(All cycles cross month boundary — window is start_day of previous month to end_day of current month)

COMMITTED EXPENSES:
${committedLines}

OPEN SPLITS (money owed to Aniket):
${openSplitsLines}

INTERNATIONAL TRANSACTIONS PENDING INR:
${internationalLines}

LOW CONFIDENCE ENRICHMENTS (need review):
${lowConfidenceLines}

PERSISTENT CONTEXT:
${contextLines}

RULES:
- Credit card bill payments are settlements of already-tracked card transactions. Never count them as new spend.
- When user says 'that transaction' or 'that last one', check recent agent_messages for which transaction was just discussed.
- International transactions have envelope_impact = 0 until INR is confirmed. When user provides the INR amount, call update_transaction with amount_inr and recalculate envelope_impact.
- After every meaningful decision or learned fact, call set_context to persist it. Examples: user's VPA for househelp, preferred transaction labels, trip budget plans.
- For low confidence or enrichment_failed transactions, proactively ask the user to confirm the category — do not wait to be asked.
- Be proactive: if you notice a pattern (e.g. Swiggy spend up 3x this week), mention it naturally, don't just answer the question asked.
- Never double-count. If unsure whether a transaction is a settlement, check the credit_cards billing window before flagging.`;
}

function buildOpenSplitsSection(db: Database.Database, splits: Split[]): string {
  const unsettled = splits.filter((s) => !s.settled && s.paid_by_you);
  if (unsettled.length === 0) return "(none)";

  const lines: string[] = [];
  for (const split of unsettled) {
    const transaction = split.transaction_id ? queryTransactions(db, { limit: 500 }).find((t) => t.id === split.transaction_id) : undefined;
    const merchant = transaction?.merchant_clean ?? transaction?.merchant_raw ?? "Unknown";
    const date = transaction?.datetime ? formatDateIst(transaction.datetime) : "unknown date";

    let people: Array<{ name: string; amount_owed: number; settled?: boolean }> = [];
    try {
      people = split.people ? JSON.parse(split.people) : [];
    } catch {
      people = [];
    }

    for (const p of people) {
      if (p.settled) continue;
      lines.push(`- ${p.name} · ₹${p.amount_owed} · ${merchant} · ${date}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(none)";
}
