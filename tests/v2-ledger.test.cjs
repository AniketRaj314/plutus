require("ts-node/register");

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { runMigrations } = require("../src/db/schema");
const { getCreditCard, insertTransaction, queryTransactions, setContext } = require("../src/db/queries");
const {
  aggregateEnvelopeEntries,
  createCommitment,
  createEnvelopeEntry,
  createReceivable,
  getActiveSalaryProfile,
  insertRawTransaction,
  listCommitments,
  listContextFacts,
  listEnvelopeEntries,
  listReceivables,
  listUninterpretedTransactions,
  setContextFact,
  updateCommitment,
  updateReceivable,
} = require("../src/db/v2-queries");
const { getCardCycleForDate } = require("../src/envelope/engine");
const { tools } = require("../src/agent/tools");
const {
  inferRawTransaction,
  parseInferenceResponse,
  processInferenceQueue,
} = require("../src/agent/inference");
const { getSalaryFundingMonthForDate } = require("../src/envelope/engine");
const { buildMcpToolSpecs, PACKAGE_VERSION } = require("../src/api/routes");
const { processMessage } = require("../src/gmail/poller");
const {
  getMessageIdForTransaction,
  getTransactionIdForMessage,
  recordTransactionMessage,
} = require("../src/telegram/bot");

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function findTool(name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

function insertTestTransaction(db, data) {
  const legacy = insertTransaction(db, data);
  insertRawTransaction(db, {
    id: legacy.id,
    source: data.source,
    amount: data.amount,
    currency: data.currency || "INR",
    amount_inr: data.amount_inr,
    merchant_raw: data.merchant_raw,
    occurred_at: data.datetime,
    card_last4: data.card_last4,
    is_reversal: Boolean(data.is_reversal),
    is_international: Boolean(data.is_international),
    raw_email_id: data.raw_email_id,
  });
  return legacy;
}

function inferenceProposal(overrides = {}) {
  return {
    decision: "interpret",
    merchant_clean: "Test Merchant",
    category: "Other",
    treatment: "normal",
    gross_amount_inr: 1000,
    personal_impact: 1000,
    cashflow_impact: 1000,
    receivable_amount: 0,
    confidence: 0.95,
    notes: null,
    question: null,
    receivable: null,
    ...overrides,
  };
}

test("v2 migration is repeatable and seeds salary/card configuration", () => {
  const db = makeDb();
  runMigrations(db);

  const profile = getActiveSalaryProfile(db);
  assert.equal(profile.id, "default");
  assert.equal(profile.salary_day, 1);
  assert.equal(profile.monthly_limit_inr, 120000);
  assert.equal(profile.currency, "INR");
  assert.equal(getCreditCard(db, "amex").billing_start_day, 21);
  assert.equal(getCreditCard(db, "bobcard").billing_end_day, 21);
  assert.equal(getCreditCard(db, "idfc_cc").due_day, 4);
  db.close();
});

test("legacy user context is migrated into shared scoped facts without internal plumbing", () => {
  const db = makeDb();
  setContext(db, "railway_commitment", "USD 5 monthly");
  setContext(db, "processed_message_ids", "[\"internal\"]");
  runMigrations(db);

  const facts = listContextFacts(db, { scope_type: "global" });
  assert.equal(facts.some((fact) => fact.key === "railway_commitment" && fact.value === "USD 5 monthly"), true);
  assert.equal(facts.some((fact) => fact.key === "processed_message_ids"), false);
  db.close();
});

test("card-cycle routing changes funding month on each exact boundary", () => {
  const db = makeDb();
  const cases = [
    ["amex", "2026-07-20T12:00:00+05:30", "2026-06-21", "2026-07-20", "2026-08-08", "2026-08"],
    ["amex", "2026-07-21T12:00:00+05:30", "2026-07-21", "2026-08-20", "2026-09-08", "2026-09"],
    ["bobcard", "2026-07-21T12:00:00+05:30", "2026-06-22", "2026-07-21", "2026-08-09", "2026-08"],
    ["bobcard", "2026-07-22T12:00:00+05:30", "2026-07-22", "2026-08-21", "2026-09-09", "2026-09"],
    ["idfc_cc", "2026-07-19T12:00:00+05:30", "2026-06-20", "2026-07-19", "2026-08-04", "2026-08"],
    ["idfc_cc", "2026-07-20T12:00:00+05:30", "2026-07-20", "2026-08-19", "2026-09-04", "2026-09"],
  ];

  for (const [source, datetime, start, end, dueDate, fundingMonth] of cases) {
    const cycle = getCardCycleForDate(getCreditCard(db, source), new Date(datetime));
    assert.deepEqual(cycle, { start, end, due_date: dueDate, funding_month: fundingMonth });
  }
  db.close();
});

test("non-card activity routes to the salary period mechanically", () => {
  assert.equal(getSalaryFundingMonthForDate(new Date("2026-07-04T12:00:00+05:30"), 5), "2026-06");
  assert.equal(getSalaryFundingMonthForDate(new Date("2026-07-05T00:00:00+05:30"), 5), "2026-07");
  assert.equal(getSalaryFundingMonthForDate(new Date("2026-07-31T23:59:00+05:30"), 1), "2026-07");
  assert.equal(getSalaryFundingMonthForDate(new Date("2026-02-28T12:00:00+05:30"), 31), "2026-02");
});

test("automatic inference persists a deterministic card cycle and is idempotent", async () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 1000,
    merchant_raw: "TEST MERCHANT",
    datetime: "2026-07-21T12:00:00+05:30",
    currency: "INR",
  });
  let calls = 0;
  const generate = async () => {
    calls++;
    return inferenceProposal();
  };

  const first = await inferRawTransaction(db, raw.id, { generate });
  const second = await inferRawTransaction(db, raw.id, { generate });

  assert.equal(first.status, "interpreted");
  assert.equal(first.entry.funding_month, "2026-09");
  assert.equal(first.entry.card_cycle_start, "2026-07-21");
  assert.equal(first.entry.card_cycle_end, "2026-08-20");
  assert.equal(first.entry.due_date, "2026-09-08");
  assert.equal(second.status, "already_interpreted");
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(calls, 1);
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-09" }).personal_impact, 1000);
  db.close();
});

test("automatic inference creates a linked receivable atomically", async () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 5800,
    merchant_raw: "ZOMATO",
    datetime: "2026-07-10T12:00:00+05:30",
    currency: "INR",
  });
  const outcome = await inferRawTransaction(db, raw.id, {
    generate: async () =>
      inferenceProposal({
        merchant_clean: "Zomato",
        category: "Food & Dining",
        treatment: "reimbursable",
        gross_amount_inr: 5800,
        personal_impact: 0,
        cashflow_impact: 5800,
        receivable_amount: 5800,
        receivable: {
          counterparty: "Employer",
          label: "Team dinner",
          amount_inr: 5800,
          expected_at: null,
          notes: null,
        },
      }),
  });

  assert.equal(outcome.status, "interpreted");
  assert.equal(outcome.receivable.envelope_entry_id, outcome.entry.id);
  assert.equal(listReceivables(db)[0].amount_inr, 5800);
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-08" }).outstanding_receivables, 5800);
  db.close();
});

test("low-confidence inference remains pending with a shared context question", async () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "idfc_upi",
    amount: 2000,
    merchant_raw: "UNKNOWN@UPI",
    datetime: "2026-07-10T12:00:00+05:30",
    currency: "INR",
  });
  const outcome = await inferRawTransaction(db, raw.id, {
    minConfidence: 0.75,
    generate: async () =>
      inferenceProposal({
        confidence: 0.4,
        question: "Was this personal, reimbursable, or a transfer?",
      }),
  });

  assert.equal(outcome.status, "needs_context");
  assert.equal(listEnvelopeEntries(db, { raw_transaction_id: raw.id }).length, 0);
  const fact = listContextFacts(db, { scope_type: "transaction", scope_id: raw.id, key: "automatic_inference" })[0];
  assert.equal(JSON.parse(fact.value).status, "needs_context");
  db.close();
});

test("failed queue inference retries at most three times", async () => {
  const db = makeDb();
  insertRawTransaction(db, {
    source: "amex",
    amount: 100,
    merchant_raw: "FAIL",
    occurred_at: "2026-07-10T12:00:00+05:30",
  });
  let calls = 0;
  const generate = async () => {
    calls++;
    throw new Error("temporary model failure");
  };
  await processInferenceQueue(db, { generate });
  await processInferenceQueue(db, { generate });
  await processInferenceQueue(db, { generate });
  await processInferenceQueue(db, { generate });
  assert.equal(calls, 3);
  assert.equal(listUninterpretedTransactions(db).length, 1);
  db.close();
});

test("a blocked queue row does not starve a newer interpretable transaction", async () => {
  const db = makeDb();
  const blocked = insertRawTransaction(db, {
    source: "idfc_upi",
    amount: 100,
    merchant_raw: "UNKNOWN",
    occurred_at: "2026-07-10T10:00:00+05:30",
  });
  const ready = insertRawTransaction(db, {
    source: "idfc_upi",
    amount: 200,
    merchant_raw: "KNOWN",
    occurred_at: "2026-07-10T11:00:00+05:30",
  });
  await inferRawTransaction(db, blocked.id, {
    generate: async () =>
      inferenceProposal({
        decision: "needs_context",
        confidence: 0.9,
        question: "What was this for?",
      }),
  });
  const outcomes = await processInferenceQueue(db, {
    limit: 1,
    generate: async () => inferenceProposal({ gross_amount_inr: 200, personal_impact: 200, cashflow_impact: 200 }),
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].raw_transaction_id, ready.id);
  assert.equal(outcomes[0].status, "interpreted");
  db.close();
});

test("inference response validation rejects malformed financial output", () => {
  assert.equal(parseInferenceResponse("not-json"), null);
  assert.equal(
    parseInferenceResponse(JSON.stringify(inferenceProposal({ category: "Made Up", confidence: 0.9 }))),
    null
  );
  assert.equal(
    parseInferenceResponse(JSON.stringify(inferenceProposal({ personal_impact: "1000" }))),
    null
  );
});

test("one active interpretation exists per raw transaction and corrections retain history", () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 1000,
    merchant_raw: "TEST MERCHANT",
    datetime: "2026-07-20T12:00:00+05:30",
    currency: "INR",
  });

  const first = createEnvelopeEntry(db, {
    raw_transaction_id: raw.id,
    funding_month: "2026-08",
    treatment: "normal",
    state: "actual",
    gross_amount_inr: 1000,
    personal_impact: 1000,
    cashflow_impact: 1000,
    created_by: "test-agent",
  });

  assert.throws(
    () =>
      createEnvelopeEntry(db, {
        raw_transaction_id: raw.id,
        funding_month: "2026-08",
        treatment: "duplicate",
        personal_impact: 1000,
        cashflow_impact: 1000,
        created_by: "test-agent",
      }),
    /UNIQUE constraint failed/
  );

  const corrected = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    treatment: "reimbursable",
    gross_amount_inr: 1000,
    personal_impact: 0,
    cashflow_impact: 1000,
    receivable_amount: 1000,
    created_by: "telegram_user",
    supersedes_id: first.id,
  });

  assert.equal(corrected.raw_transaction_id, raw.id);
  assert.equal(listEnvelopeEntries(db, { raw_transaction_id: raw.id }).length, 1);
  const history = listEnvelopeEntries(db, { raw_transaction_id: raw.id, include_superseded: true });
  assert.equal(history.length, 2);
  assert.equal(history.find((entry) => entry.id === first.id).replaced_by_id, corrected.id);

  const summary = aggregateEnvelopeEntries(db, { funding_month: "2026-08" });
  assert.equal(summary.personal_impact, 0);
  assert.equal(summary.cashflow_impact, 1000);
  assert.equal(summary.receivable_amount, 1000);
  db.close();
});

test("forecast replacement prevents double counting", () => {
  const db = makeDb();
  const forecast = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    merchant_clean: "Rent",
    treatment: "committed",
    state: "forecast",
    gross_amount_inr: 30000,
    personal_impact: 30000,
    cashflow_impact: 30000,
    created_by: "claude",
  });
  createEnvelopeEntry(db, {
    funding_month: "2026-08",
    merchant_clean: "Landlord",
    treatment: "committed",
    state: "actual",
    gross_amount_inr: 30200,
    personal_impact: 30200,
    cashflow_impact: 30200,
    created_by: "codex",
    supersedes_id: forecast.id,
  });

  const summary = aggregateEnvelopeEntries(db, { funding_month: "2026-08" });
  assert.equal(summary.entry_count, 1);
  assert.equal(summary.personal_impact, 30200);
  db.close();
});

test("scoped context is shared, versioned, and queryable", () => {
  const db = makeDb();
  const first = setContextFact(db, {
    scope_type: "merchant",
    scope_id: "Kaha Mind",
    key: "reimbursement_policy",
    value: "Employer reimburses",
    source: "telegram_user",
    confidence: 1,
  });
  const second = setContextFact(db, {
    scope_type: "merchant",
    scope_id: "Kaha Mind",
    key: "reimbursement_policy",
    value: "Employer reimburses fully; timing is uncertain",
    source: "codex",
    confidence: 1,
  });

  const active = listContextFacts(db, { scope_type: "merchant", scope_id: "Kaha Mind" });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, second.id);
  assert.equal(active[0].supersedes_id, first.id);
  const history = listContextFacts(db, {
    scope_type: "merchant",
    scope_id: "Kaha Mind",
    include_superseded: true,
  });
  assert.equal(history.length, 2);
  db.close();
});

test("receivables support pending, partial, and received states", () => {
  const db = makeDb();
  const entry = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    treatment: "reimbursable",
    personal_impact: 0,
    cashflow_impact: 5872.8,
    receivable_amount: 5872.8,
    created_by: "codex",
  });
  const item = createReceivable(db, {
    envelope_entry_id: entry.id,
    counterparty: "Employer",
    label: "Team dinner",
    amount_inr: 5872.8,
    created_by: "codex",
  });
  assert.equal(item.status, "pending");
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-08" }).outstanding_receivables, 5872.8);

  const partial = updateReceivable(db, item.id, { received_inr: 2000 });
  assert.equal(partial.status, "partial");
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-08" }).outstanding_receivables, 3872.8);
  const received = updateReceivable(db, item.id, { received_inr: 5872.8 });
  assert.equal(received.status, "received");
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-08" }).outstanding_receivables, 0);
  assert.equal(listReceivables(db).length, 0);
  assert.equal(listReceivables(db, { include_closed: true }).length, 1);
  db.close();
});

test("correcting an interpretation preserves and reattributes its open receivable", () => {
  const db = makeDb();
  const original = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    source: "amex",
    treatment: "reimbursable",
    personal_impact: 0,
    cashflow_impact: 5000,
    receivable_amount: 5000,
    created_by: "codex",
  });
  const receivable = createReceivable(db, {
    envelope_entry_id: original.id,
    counterparty: "Employer",
    label: "Therapy reimbursement",
    amount_inr: 5000,
    created_by: "codex",
  });

  const corrected = createEnvelopeEntry(db, {
    funding_month: "2026-09",
    source: "amex",
    treatment: "reimbursable",
    personal_impact: 0,
    cashflow_impact: 5000,
    receivable_amount: 5000,
    created_by: "telegram_user",
    supersedes_id: original.id,
  });

  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-08" }).outstanding_receivables, 0);
  assert.equal(aggregateEnvelopeEntries(db, { funding_month: "2026-09" }).outstanding_receivables, 5000);
  assert.equal(db.prepare("SELECT envelope_entry_id FROM receivables WHERE id = ?").get(receivable.id).envelope_entry_id, corrected.id);
  db.close();
});

test("temporary commitments have explicit lifetimes and can complete", () => {
  const db = makeDb();
  const commitment = createCommitment(db, {
    label: "Lego EMI principal",
    amount_inr: 8621.27,
    start_funding_month: "2026-08",
    end_funding_month: "2027-01",
    remaining_occurrences: 6,
    created_by: "codex",
  });
  assert.equal(listCommitments(db, { funding_month: "2026-10" }).length, 1);
  assert.equal(listCommitments(db, { funding_month: "2027-02" }).length, 0);
  const completed = updateCommitment(db, commitment.id, { remaining_occurrences: 0, status: "completed" });
  assert.equal(completed.status, "completed");
  db.close();
});

test("date-only until filter is inclusive and interpretation queue is deterministic", () => {
  const db = makeDb();
  const onBoundary = insertTestTransaction(db, {
    source: "amex",
    amount: 100,
    merchant_raw: "BOUNDARY",
    datetime: "2026-07-20T23:59:00+05:30",
    currency: "INR",
  });
  insertTestTransaction(db, {
    source: "amex",
    amount: 200,
    merchant_raw: "NEXT DAY",
    datetime: "2026-07-21T00:01:00+05:30",
    currency: "INR",
  });

  const throughBoundary = listUninterpretedTransactions(db, {
    source: "amex",
    until: "2026-07-20",
  });
  assert.deepEqual(throughBoundary.map((row) => row.id), [onBoundary.id]);
  assert.deepEqual(
    queryTransactions(db, { source: "amex", until: "2026-07-20", limit: 20 }).map((row) => row.id),
    [onBoundary.id]
  );

  createEnvelopeEntry(db, {
    raw_transaction_id: onBoundary.id,
    funding_month: "2026-08",
    treatment: "normal",
    personal_impact: 100,
    cashflow_impact: 100,
    created_by: "test",
  });
  assert.equal(listUninterpretedTransactions(db, { source: "amex", until: "2026-07-20" }).length, 0);
  db.close();
});

test("MCP entry tool derives INR gross amount from resolved international transaction", async () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 23.6,
    amount_inr: 2323.53,
    merchant_raw: "ANTHROPIC",
    datetime: "2026-06-22T12:00:00+05:30",
    currency: "USD",
    is_international: 1,
  });
  const created = await findTool("create_envelope_entry").handler(db, {
    raw_transaction_id: raw.id,
    funding_month: "2026-08",
    treatment: "committed",
    personal_impact: 2323.53,
    cashflow_impact: 2323.53,
    created_by: "test-agent",
  });
  assert.equal(created.gross_amount_inr, 2323.53);
  db.close();
});

test("manual transaction MCP ingestion preserves immutable raw evidence", async () => {
  const db = makeDb();
  const result = await findTool("create_transaction").handler(db, {
    source: "amex",
    amount: 480,
    merchant_raw: "FASTMAIL",
    merchant_clean: "Fastmail",
    category: "Software",
    datetime: "2026-07-10T12:00:00+05:30",
    currency: "INR",
  });
  const raw = db.prepare("SELECT * FROM raw_transactions WHERE id = ?").get(result.transaction.id);
  assert.equal(raw.amount, 480);
  assert.equal(raw.merchant_raw, "FASTMAIL");
  assert.equal(raw.occurred_at, "2026-07-10T12:00:00+05:30");
  assert.equal(listUninterpretedTransactions(db, { source: "amex" }).length, 1);
  db.close();
});

test("Gmail ingestion dual-writes evidence, invokes v2 inference, and does not mutate the legacy envelope", async () => {
  const db = makeDb();
  const body =
    "Transaction of INR 525.50 made at on 27-05-2026 has been refunded to your IDFC FIRST Bank Credit Card ending XX6198.";
  const message = {
    id: "gmail-reversal-1",
    snippet: body,
    payload: {
      headers: [
        { name: "From", value: "noreply@idfcfirstbank.com" },
        { name: "Subject", value: "Transaction reversal!" },
      ],
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } }],
    },
  };

  let telegramText = "";
  await processMessage(db, message, {
    sendTelegram: async (text) => {
      telegramText = text;
      return 9876;
    },
    inferenceGenerator: async () =>
      inferenceProposal({
        merchant_clean: "Refund",
        treatment: "refund",
        gross_amount_inr: 525.5,
        personal_impact: -525.5,
        cashflow_impact: -525.5,
      }),
  });
  const raw = db.prepare("SELECT * FROM raw_transactions WHERE raw_email_id = ?").get("gmail-reversal-1");
  assert.equal(raw.amount, 525.5);
  assert.equal(raw.is_reversal, 1);
  assert.equal(raw.source, "idfc_cc");
  const clean = listEnvelopeEntries(db, { raw_transaction_id: raw.id })[0];
  assert.equal(clean.treatment, "refund");
  assert.equal(clean.personal_impact, -525.5);
  assert.equal(db.prepare("SELECT envelope_applied FROM transactions WHERE id = ?").get(raw.id).envelope_applied, 0);
  assert.match(telegramText, /refund · Personal/);
  assert.match(telegramText, /funding month/);
  assert.equal(getTransactionIdForMessage(db, 9876), raw.id);
  db.close();
});

test("Gmail retry recovers a stored transaction whose Telegram alert failed", async () => {
  const db = makeDb();
  const body =
    "Transaction of INR 125.00 made at on 27-05-2026 has been refunded to your IDFC FIRST Bank Credit Card ending XX6198.";
  const message = {
    id: "gmail-recovery-1",
    snippet: body,
    payload: {
      headers: [
        { name: "From", value: "noreply@idfcfirstbank.com" },
        { name: "Subject", value: "Transaction reversal!" },
      ],
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") } }],
    },
  };
  let inferenceCalls = 0;
  const inferenceGenerator = async () => {
    inferenceCalls++;
    return inferenceProposal({
      merchant_clean: "Refund",
      treatment: "refund",
      gross_amount_inr: 125,
      personal_impact: -125,
      cashflow_impact: -125,
    });
  };

  await assert.rejects(
    processMessage(db, message, {
      inferenceGenerator,
      sendTelegram: async () => {
        throw new Error("Telegram unavailable");
      },
    }),
    /Telegram unavailable/
  );
  const raw = db.prepare("SELECT * FROM raw_transactions WHERE raw_email_id = ?").get("gmail-recovery-1");
  assert.equal(listEnvelopeEntries(db, { raw_transaction_id: raw.id }).length, 1);
  assert.equal(getMessageIdForTransaction(db, raw.id), undefined);

  await processMessage(db, message, {
    inferenceGenerator,
    sendTelegram: async () => 4321,
  });
  assert.equal(inferenceCalls, 1);
  assert.equal(getTransactionIdForMessage(db, 4321), raw.id);
  db.close();
});

test("Telegram reply linkage remains stable because raw and legacy ids are identical", () => {
  const db = makeDb();
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 100,
    merchant_raw: "TEST",
    datetime: "2026-07-10T12:00:00+05:30",
    currency: "INR",
  });
  recordTransactionMessage(db, 12345, raw.id);
  assert.equal(getTransactionIdForMessage(db, 12345), raw.id);
  assert.equal(db.prepare("SELECT id FROM raw_transactions WHERE id = ?").get(raw.id).id, raw.id);
  db.close();
});

test("all v2 MCP tools are registered for external agents", () => {
  const expected = [
    "create_raw_transaction",
    "bulk_create_raw_transactions",
    "get_raw_transactions",
    "get_salary_profile",
    "update_salary_profile",
    "get_card_cycle_for_date",
    "list_uninterpreted_transactions",
    "infer_raw_transaction",
    "interpret_pending_transactions",
    "create_envelope_entry",
    "list_envelope_entries",
    "get_funding_summary",
    "set_context_fact",
    "list_context_facts",
    "create_receivable",
    "update_receivable",
    "list_receivables",
    "create_commitment",
    "update_commitment",
    "list_commitments_v2",
  ];
  for (const name of expected) findTool(name);
});

test("production MCP surface exposes v2 finance tools and no legacy envelope mutators", () => {
  const names = buildMcpToolSpecs().map((spec) => spec.name);
  assert.equal(names.includes("interpret_pending_transactions"), true);
  assert.equal(names.includes("post_agent_message"), true);
  assert.equal(names.includes("get_envelope"), false);
  assert.equal(names.includes("recalculate_envelope"), false);
  assert.equal(names.includes("create_transaction"), false);
});

test("health metadata reads the deployed package version", () => {
  assert.equal(PACKAGE_VERSION, require("../package.json").version);
});

test("raw MCP ingestion is idempotent by email id and bulk failures are isolated", async () => {
  const db = makeDb();
  const create = findTool("create_raw_transaction");
  const first = await create.handler(db, {
    source: "amex",
    amount: 100,
    merchant_raw: "TEST",
    occurred_at: "2026-07-20T12:00:00+05:30",
    raw_email_id: "same-email",
    is_preauth: true,
  });
  const duplicate = await create.handler(db, {
    source: "amex",
    amount: 100,
    merchant_raw: "TEST",
    occurred_at: "2026-07-20T12:00:00+05:30",
    raw_email_id: "same-email",
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(first.is_preauth, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_transactions").get().count, 1);

  const bulk = await findTool("bulk_create_raw_transactions").handler(db, {
    transactions: [
      { source: "amex", amount: 200, occurred_at: "2026-07-21T12:00:00+05:30" },
      { source: "amex", amount: 300, occurred_at: "not-a-date" },
    ],
  });
  assert.equal(bulk.created, 1);
  assert.equal(bulk.failed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_transactions").get().count, 2);
  db.close();
});

test("AmEx regression separates personal impact, temporary cash, and receivables", () => {
  const db = makeDb();
  const entries = [
    // Ordinary personal activity after excluding reimbursements and financed principal.
    ["ordinary", 31429.62, 31429.62, 0, 31429.62],
    // Six-month principal recognition replaces the full Amazon purchase in the envelope.
    ["emi", 8621.27, 8621.27, 0, 8621.27],
    // Pending employer items are not personal spend but still need temporary cash.
    ["reimbursable", 0, 10592.8, 10592.8, 10592.8],
    // The full financed purchase remains visible as evidence but has no immediate impact.
    ["financed_principal", 0, 0, 0, 51727.6],
    // Travel reimbursements were already received, so neither impact remains.
    ["reimbursement_settled", 0, 0, 0, 40474],
  ];
  for (const [treatment, personal, cashflow, receivable, gross] of entries) {
    createEnvelopeEntry(db, {
      funding_month: "2026-08",
      treatment,
      state: "actual",
      gross_amount_inr: gross,
      personal_impact: personal,
      cashflow_impact: cashflow,
      receivable_amount: receivable,
      created_by: "regression-fixture",
    });
  }

  const summary = aggregateEnvelopeEntries(db, { funding_month: "2026-08", group_by: "treatment" });
  assert.equal(summary.personal_impact, 40050.89);
  assert.equal(summary.cashflow_impact, 50643.69);
  assert.equal(summary.receivable_amount, 10592.8);
  assert.equal(summary.personal_remaining, 79949.11);
  db.close();
});
