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
import {
  getActiveSalaryProfile,
  listCommitments,
  listContextFacts,
  listReceivables,
  listUninterpretedTransactions,
} from "../db/v2-queries";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function todayIst(): Date {
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

export function daysUntilSalaryDay(salaryDay: number | null): number {
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
  const salaryProfile = getActiveSalaryProfile(db);
  const v2Commitments = listCommitments(db, { status: "active" });
  const v2Receivables = listReceivables(db);
  const v2Context = listContextFacts(db)
    .filter((fact) => fact.key !== "automatic_inference")
    .slice(0, 100);
  const pendingCreditProposals = v2Context.filter((fact) => {
    if (fact.key !== "credit_allocation") return false;
    try {
      return JSON.parse(fact.value).status === "proposed";
    } catch {
      return false;
    }
  });
  const uninterpreted = listUninterpretedTransactions(db, { limit: 20 });

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
    (row) =>
      row.key !== "telegram_message_map" &&
      row.key !== "processed_message_ids" &&
      row.key !== "gmail_sync_alert_state"
  );
  const contextLines =
    context.length > 0 ? context.map((row) => `- ${row.key}: ${row.value}`).join("\n") : "(none)";

  const v2CommitmentLines =
    v2Commitments.length > 0
      ? v2Commitments
          .map(
            (c) =>
              `- ${c.label} · ₹${c.amount_inr} · ${c.start_funding_month} → ${c.end_funding_month ?? "open-ended"} · ${c.remaining_occurrences ?? "ongoing"} occurrence(s)`
          )
          .join("\n")
      : "(none)";
  const v2ReceivableLines =
    v2Receivables.length > 0
      ? v2Receivables
          .map((r) => `- ${r.counterparty} owes ₹${r.amount_inr - r.received_inr} · ${r.label} · ${r.status}`)
          .join("\n")
      : "(none)";
  const v2ContextLines =
    v2Context.length > 0
      ? v2Context.map((fact) => `- [${fact.scope_type}:${fact.scope_id || "global"}] ${fact.key}: ${fact.value}`).join("\n")
      : "(none)";
  const pendingCreditProposalLines =
    pendingCreditProposals.length > 0
      ? pendingCreditProposals
          .map((fact) => `- transaction ${fact.scope_id}: ${fact.value}`)
          .join("\n")
      : "(none)";

  return `You are Plutus, Aniket's personal finance agent. You are concise, direct, and slightly witty. You communicate primarily via Telegram so keep responses short and punchy unless the user explicitly asks for detail. Use ₹ for Indian Rupee amounts.

TODAY: ${todayIst().toISOString().slice(0, 10)} (IST)

V2 SALARY FUNDING PROFILE:
- Monthly limit: ₹${salaryProfile?.monthly_limit_inr ?? 120000}
- Salary day: ${ordinal(salaryProfile?.salary_day ?? 1)}
- Raw transactions awaiting interpretation: ${uninterpreted.length}${uninterpreted.length === 20 ? "+" : ""}

V2 COMMITMENTS:
${v2CommitmentLines}

V2 OPEN RECEIVABLES:
${v2ReceivableLines}

PENDING INCOMING-CREDIT PROPOSALS (AI suggestions awaiting the user's decision):
${pendingCreditProposalLines}

V2 SHARED CONTEXT:
${v2ContextLines}

LEGACY ENVELOPE STATE (migration-only; do not use for new recommendations when v2 entries exist):
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
- Raw transactions are immutable evidence. Never encode a financial interpretation by overwriting the raw transaction.
- Use get_card_cycle_for_date to mechanically find a card transaction's statement cycle and salary funding month.
- Persist financial meaning with create_envelope_entry. personal_impact is the true expense against the ₹1,20,000 limit; cashflow_impact is temporary cash required; receivable_amount is money owed back.
- When correcting an interpretation, create a replacement entry with supersedes_id. Never create two active interpretations for one raw transaction.
- Use set_context_fact for shared knowledge. Scope merchant rules to merchants, card rules to cards, transaction facts to transaction ids, and people-specific facts to people.
- Reimbursements and split debts must also be stored with create_receivable and updated when money arrives.
- Incoming credits require interpretation; the backend does not decide what they mean. Use sender/VPA, amount, open receivables, transaction context, and the pending AI proposal to reason about repayments, partial payments, combined payments, surplus, refunds, salary, or transfers.
- Never confirm a proposed credit allocation merely because amounts match. Ask the user first. Only after explicit confirmation call record_confirmed_credit_allocation with allocations covering the complete credit.
- A confirmed receivable repayment or intentional surplus normally has personal_impact=0, so it neither consumes nor increases the spending envelope. Use negative cashflow_impact to represent cash returning to the account when appropriate.
- Preserve unexplained or intentional excess as a separate semantic allocation such as unallocated_surplus, with notes capturing the user's confirmation. Do not silently turn it into income, debt, or future credit.
- A commitment is shared knowledge, not spend by itself. Create explicit forecast envelope entries for a funding month; an actual charge must supersede its forecast to avoid double-counting.
- For questions such as "how much did I spend in July?", "July spend", or the monthly ₹1,20,000 envelope, always call get_spend_month_summary. Its canonical definition is: card entries belong to the month their statement cycle ends; IDFC savings/UPI entries belong to their IST occurrence month; stored personal_impact supplies the financial treatment. Do not substitute get_funding_summary for this question.
- For questions about the latest, newest, recent, or missing transaction, always call get_raw_transactions with the relevant source/date filters before answering. Never infer transaction freshness from chat history or previously sent Telegram notifications.
- Use get_funding_summary only when the user asks which salary funds an obligation, what a salary must settle, or another cash-funding question.
- Weekly budget recommendations are your responsibility: query get_spend_month_summary for the current spending month plus relevant entries/commitments, then reason in the response. The backend only stores facts and returns deterministic sums.
- Credit card bill payments are settlements of already-tracked card transactions. Never count them as new spend.
- When user says 'that transaction' or 'that last one', check recent agent_messages for which transaction was just discussed.
- International transactions remain uninterpreted until their final INR amount is known. Persist the confirmed INR amount as transaction-scoped context, then create the clean envelope entry with the confirmed gross/personal/cash-flow values.
- After every meaningful decision or learned fact, call set_context_fact so Claude, OpenAI, Telegram, and other MCP agents share the same scoped memory. Use legacy set_context only for internal plumbing compatibility.
- For low confidence or enrichment_failed transactions, proactively ask the user to confirm the category — do not wait to be asked.
- Be proactive: if you notice a pattern (e.g. Swiggy spend up 3x this week), mention it naturally, don't just answer the question asked.
- Never double-count. If unsure whether a transaction is a settlement, check the credit_cards billing window before flagging.
- You can correct any bank-parsed field on a transaction (datetime, amount, merchant_raw/merchant_clean, card_last4, etc.) via update_transaction — bank alert emails are sometimes incomplete (e.g. AmEx sends no time-of-day, only a date) or occasionally wrong. Always state the specific correction back to the user and get their confirmation before calling update_transaction to apply it — never silently overwrite bank-parsed data.`;
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
