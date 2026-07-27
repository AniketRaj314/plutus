require("ts-node/register");

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { runMigrations } = require("../src/db/schema");
const { getContext, getCreditCard, insertTransaction, queryTransactions, setContext } = require("../src/db/queries");
const {
  aggregateSpendMonth,
  aggregateEnvelopeEntries,
  createCommitment,
  createEnvelopeEntry,
  createFlexBudgetPlan,
  createReceivable,
  getCounterpartyBalance,
  getFlexBudgetStatus,
  getActiveSalaryProfile,
  insertRawTransaction,
  listCommitments,
  listContextFacts,
  listEnvelopeEntries,
  listReceivables,
  listUninterpretedTransactions,
  recordConfirmedCreditAllocation,
  setContextFact,
  setFlexBudgetClassification,
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
const { buildMcpToolSpecs, PACKAGE_VERSION, registerRoutes } = require("../src/api/routes");
const {
  isLikelyTransactionAlert,
  notifyPendingCreditInferences,
  pollOnce,
  processMessage,
  runGmailPollCycle,
  selectMessageIdsForPoll,
} = require("../src/gmail/poller");
const { parseGmailMessage } = require("../src/gmail/parsers");
const {
  describeGmailDiagnosticError,
  searchTransactionEmails,
} = require("../src/gmail/diagnostics");
const { buildSystemPrompt } = require("../src/agent/prompts");
const { formatV2Transaction } = require("../src/telegram/formatter");
const {
  configureScheduler,
  getSchedulerHealth,
  nextCronTick,
  resetSchedulerHealthForTests,
  runSchedulerCycle,
} = require("../src/scheduler/status");
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
    credit_allocations: [],
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
  assert.deepEqual(
    {
      last4: getCreditCard(db, "icici_cc").last4,
      start: getCreditCard(db, "icici_cc").billing_start_day,
      end: getCreditCard(db, "icici_cc").billing_end_day,
      due: getCreditCard(db, "icici_cc").due_day,
    },
    { last4: "6017", start: 21, end: 20, due: 7 }
  );
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
  const definition = facts.find((fact) => fact.key === "monthly_spending_envelope_definition");
  assert.ok(definition);
  const parsedDefinition = JSON.parse(definition.value);
  assert.equal(parsedDefinition.canonical_mcp_tool, "get_spend_month_summary");
  assert.equal(parsedDefinition.definition_version, 2);
  assert.match(parsedDefinition.manual_rule, /user-reported purchase events/);
  db.close();
});

test("canonical spend-month summary combines card cycles with IST UPI and manual purchase activity", () => {
  const db = makeDb();
  const add = (entry) =>
    createEnvelopeEntry(db, {
      funding_month: entry.funding_month ?? "2026-08",
      occurred_at: entry.occurred_at,
      source: entry.source,
      card_cycle_start: entry.card_cycle_start,
      card_cycle_end: entry.card_cycle_end,
      due_date: entry.due_date,
      treatment: entry.treatment ?? "normal",
      state: entry.state ?? "actual",
      gross_amount_inr: entry.gross_amount_inr ?? Math.abs(entry.personal_impact),
      personal_impact: entry.personal_impact,
      cashflow_impact: entry.cashflow_impact ?? entry.personal_impact,
      receivable_amount: 0,
      created_by: "test",
    });

  add({ source: "amex", occurred_at: "2026-06-25T12:00:00+05:30", card_cycle_start: "2026-06-21", card_cycle_end: "2026-07-20", due_date: "2026-08-08", personal_impact: 1000 });
  add({ source: "amex", occurred_at: "2026-07-20T12:00:00+05:30", card_cycle_start: "2026-06-21", card_cycle_end: "2026-07-20", due_date: "2026-08-08", personal_impact: 100, state: "forecast" });
  add({ source: "amex", occurred_at: "2026-07-21T12:00:00+05:30", card_cycle_start: "2026-07-21", card_cycle_end: "2026-08-20", due_date: "2026-09-08", funding_month: "2026-09", personal_impact: 2000 });
  add({ source: "bobcard", occurred_at: "2026-07-21T12:00:00+05:30", card_cycle_start: "2026-06-22", card_cycle_end: "2026-07-21", due_date: "2026-08-09", personal_impact: 300 });
  add({ source: "idfc_cc", occurred_at: "2026-07-19T12:00:00+05:30", card_cycle_start: "2026-06-20", card_cycle_end: "2026-07-19", due_date: "2026-08-04", personal_impact: 400 });
  add({ source: "icici_cc", occurred_at: "2026-07-18T18:03:26+05:30", card_cycle_start: "2026-06-21", card_cycle_end: "2026-07-20", due_date: "2026-08-07", personal_impact: 500 });
  add({ source: "idfc_upi", occurred_at: "2026-07-01T12:00:00+05:30", funding_month: "2026-07", personal_impact: 500 });
  add({ source: "idfc_upi", occurred_at: "2026-07-31T18:00:00.000Z", funding_month: "2026-07", personal_impact: 200 });
  add({ source: "idfc_upi", occurred_at: "2026-07-31T18:45:00.000Z", funding_month: "2026-08", personal_impact: 700 });
  add({ source: "idfc_upi", occurred_at: "2026-07-08T12:00:00+05:30", funding_month: "2026-08", personal_impact: -30, treatment: "split" });
  add({ source: "idfc_upi", occurred_at: "2026-07-03T12:00:00+05:30", funding_month: "2026-07", personal_impact: 0, treatment: "settlement" });
  add({
    source: "manual",
    occurred_at: "2026-07-26T12:00:00+05:30",
    funding_month: "2026-07",
    gross_amount_inr: 5687,
    personal_impact: 3791.33,
    cashflow_impact: 0,
    treatment: "split",
  });

  const summary = aggregateSpendMonth(db, { spend_month: "2026-07", group_by: "source" });
  assert.equal(summary.personal_impact, 6761.33);
  assert.equal(summary.actual_personal_impact, 6661.33);
  assert.equal(summary.forecast_personal_impact, 100);
  assert.equal(summary.personal_remaining, 113238.67);
  assert.equal(summary.entry_count, 10);
  assert.equal(summary.actual_entry_count, 9);
  assert.equal(summary.forecast_entry_count, 1);
  assert.deepEqual(summary.upi_window, { start: "2026-07-01", end: "2026-07-31" });
  assert.equal(summary.card_cycles.length, 4);
  assert.equal(summary.groups.find((group) => group.group_key === "idfc_upi").personal_impact, 670);
  assert.equal(summary.groups.find((group) => group.group_key === "icici_cc").personal_impact, 500);
  assert.equal(summary.groups.find((group) => group.group_key === "manual").personal_impact, 3791.33);
  assert.equal(summary.definition_version, 2);
  assert.match(summary.definition.manual, /user-reported purchase events/);
  db.close();
});

test("Telegram transaction presentation labels the canonical spend month and renders overspend clearly", () => {
  const text = formatV2Transaction(
    {
      source: "amex",
      amount: 277,
      merchant_clean: "Razorpay Restaurants",
      datetime: "2026-07-15T06:35:04.000Z",
      is_reversal: 0,
      is_international: 0,
    },
    {
      status: "interpreted",
      entry: {
        treatment: "normal",
        personal_impact: 277,
        cashflow_impact: 277,
        receivable_amount: 0,
        funding_month: "2026-08",
      },
      spend_month: "2026-07",
      spend_month_remaining: -4958,
    }
  );

  assert.doesNotMatch(text, /funding month/);
  assert.match(text, /July 2026 spending envelope: ₹4,958 over/);
  assert.doesNotMatch(text, /personal envelope remaining/);
});

test("ICICI credit-card parser preserves the issuer timestamp and merchant", () => {
  const body =
    "Dear Customer, Your ICICI Bank Credit Card XX6017 has been used for a transaction of INR 500.00 on Jul 18, 2026 at 06:03:26. Info: AMAZON PAY INDIA PVT LTD. The Available Credit Limit on your card is INR 1,98,401.00 and Total Credit Limit is INR 2,00,000.00.";
  const message = {
    id: "icici-live-alert",
    internalDate: String(Date.parse("2026-07-18T12:33:37.000Z")),
    snippet: body,
    payload: {
      headers: [
        { name: "From", value: "credit_cards@icici.bank.in" },
        { name: "Subject", value: "Transaction alert for your ICICI Bank Credit Card" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };

  const parsed = parseGmailMessage(message);
  assert.ok(parsed);
  assert.equal(parsed.source, "icici_cc");
  assert.equal(parsed.amount, 500);
  assert.equal(parsed.currency, "INR");
  assert.equal(parsed.card_last4, "6017");
  assert.equal(parsed.merchant_raw, "AMAZON PAY INDIA PVT LTD");
  assert.equal(parsed.datetime, "2026-07-18T12:33:26.000Z");
  assert.equal(parsed.direction, "debit");
});

test("ICICI declined attempts and informational card mail are ignored", () => {
  const declinedBody =
    "Dear Customer, As the service for domestic online transactions is disabled, your transaction of INR 1000.00 using your ICICI Bank Credit Card XX6017 has been declined on Jun 08, 2026 at 12:41:57.";
  const declined = {
    id: "icici-declined-alert",
    snippet: declinedBody,
    payload: {
      headers: [
        { name: "From", value: "credit_cards@icici.bank.in" },
        { name: "Subject", value: "Transaction alert for your ICICI Bank Credit Card" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(declinedBody).toString("base64url") },
    },
  };
  const paymentReceived = {
    id: "icici-payment-received",
    snippet: "We have received payment of INR 1000.00 on your ICICI Bank Credit Card account.",
    payload: {
      headers: [
        { name: "From", value: "credit_cards@icici.bank.in" },
        { name: "Subject", value: "Payment received on your ICICI Bank Credit Card." },
      ],
    },
  };

  assert.equal(parseGmailMessage(declined), null);
  assert.equal(isLikelyTransactionAlert(declined), false);
  assert.equal(parseGmailMessage(paymentReceived), null);
  assert.equal(isLikelyTransactionAlert(paymentReceived), false);
});

test("ICICI Gmail ingestion creates a cycle-aware raw and clean ledger entry", async () => {
  const db = makeDb();
  const body =
    "Dear Customer, Your ICICI Bank Credit Card XX6017 has been used for a transaction of INR 500.00 on Jul 18, 2026 at 06:03:26. Info: AMAZON PAY INDIA PVT LTD. The Available Credit Limit on your card is INR 1,98,401.00 and Total Credit Limit is INR 2,00,000.00.";
  const message = {
    id: "icici-ingestion-alert",
    internalDate: String(Date.parse("2026-07-18T12:33:37.000Z")),
    snippet: body,
    payload: {
      headers: [
        { name: "From", value: "credit_cards@icici.bank.in" },
        { name: "Subject", value: "Transaction alert for your ICICI Bank Credit Card" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };

  let telegramText = "";
  const outcome = await processMessage(db, message, {
    enrich: async () => {},
    inferenceGenerator: async () =>
      inferenceProposal({
        merchant_clean: "Amazon Pay",
        category: "Shopping",
        gross_amount_inr: 500,
        personal_impact: 500,
        cashflow_impact: 500,
      }),
    sendTelegram: async (text) => {
      telegramText = text;
      return 6017;
    },
  });

  assert.equal(outcome, "recorded");
  const raw = db.prepare("SELECT * FROM raw_transactions WHERE raw_email_id = ?").get(message.id);
  assert.equal(raw.source, "icici_cc");
  assert.equal(raw.occurred_at, "2026-07-18T12:33:26.000Z");
  const entry = listEnvelopeEntries(db, { raw_transaction_id: raw.id })[0];
  assert.equal(entry.card_cycle_start, "2026-06-21");
  assert.equal(entry.card_cycle_end, "2026-07-20");
  assert.equal(entry.due_date, "2026-08-07");
  assert.equal(entry.funding_month, "2026-08");
  assert.match(telegramText, /ICICI CC/);
  assert.match(telegramText, /July 2026 spending envelope/);
  db.close();
});

test("AmEx uses Gmail receipt time when its alert only contains a transaction date", () => {
  const html = [
    "<p>Date:</p><p>15 July 2026</p>",
    "<p>Merchant:</p><p>Razorpay Restaurants</p>",
    "<p>Amount:</p><p>INR 277.00</p>",
    "<p>Account Ending: 41001</p>",
  ].join("");
  const message = {
    id: "amex-received-time",
    internalDate: String(Date.parse("2026-07-15T06:35:04.000Z")),
    payload: {
      headers: [
        { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
        { name: "Subject", value: "Your transaction update" },
      ],
      mimeType: "text/html",
      body: { data: Buffer.from(html).toString("base64url") },
    },
  };

  const parsed = parseGmailMessage(message);
  assert.ok(parsed);
  assert.equal(parsed.datetime, "2026-07-15T06:35:04.000Z");
  assert.equal(parsed.amount, 277);
  assert.equal(parsed.merchant_raw, "Razorpay Restaurants");
});

test("AmEx parses dollar-symbol transaction alerts as pending USD transactions", () => {
  const html = [
    "<p>Date:</p><p>16 July 2026</p>",
    "<p>Merchant:</p><p>Points a Plusgrade Co.</p>",
    "<p>Amount:</p><p>$50.00</p>",
    "<p>Account Ending: 41001</p>",
  ].join("");
  const message = {
    id: "amex-dollar-symbol",
    internalDate: String(Date.parse("2026-07-16T15:13:45.000Z")),
    payload: {
      headers: [
        { name: "From", value: "American Express <AmericanExpress@welcome.americanexpress.com>" },
        { name: "Subject", value: "Your transaction update" },
      ],
      mimeType: "text/html",
      body: { data: Buffer.from(html).toString("base64url") },
    },
  };

  const parsed = parseGmailMessage(message);
  assert.ok(parsed);
  assert.equal(parsed.amount, 50);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.amount_inr, null);
  assert.equal(parsed.is_international, true);
  assert.equal(parsed.notes, "pending_forex_resolution");
  assert.equal(parsed.merchant_raw, "Points a Plusgrade Co.");
});

test("Gmail distinguishes ignored mail from an unparseable likely transaction alert", async () => {
  const db = makeDb();
  const unparseable = {
    id: "unparseable-amex-alert",
    payload: {
      headers: [
        { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
        { name: "Subject", value: "Your transaction update" },
      ],
      mimeType: "text/html",
      body: {
        data: Buffer.from(
          "<p>Date:</p><p>16 July 2026</p><p>Merchant:</p><p>Unknown</p><p>Amount:</p><p>fifty dollars</p>"
        ).toString("base64url"),
      },
    },
  };
  const informational = {
    id: "amex-points-transfer",
    payload: {
      headers: [
        { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
        { name: "Subject", value: "Good news! Your points have been transferred" },
      ],
    },
  };

  assert.equal(isLikelyTransactionAlert(unparseable), true);
  assert.equal(await processMessage(db, unparseable), "unparseable");
  assert.equal(isLikelyTransactionAlert(informational), false);
  assert.equal(await processMessage(db, informational), "ignored");
  db.close();
});

test("Gmail MCP diagnostics expose parser and storage state without returning email bodies", async () => {
  const db = makeDb();
  const matchedHtml = [
    "<p>Date:</p><p>20 July 2026</p>",
    "<p>Merchant:</p><p>Aladdin Shawarma</p>",
    "<p>Amount:</p><p>INR 327.00</p>",
    "<p>Account Ending: 41001</p>",
    "<p>PRIVATE BODY CONTENT</p>",
  ].join("");
  const messages = {
    "matched-alert": {
      id: "matched-alert",
      threadId: "thread-1",
      internalDate: String(Date.parse("2026-07-20T06:51:00.000Z")),
      snippet: "Transaction Update for Aladdin Shawarma",
      payload: {
        headers: [
          { name: "From", value: "American Express <AmericanExpress@welcome.americanexpress.com>" },
          { name: "Subject", value: "Your transaction update" },
        ],
        mimeType: "text/html",
        body: { data: Buffer.from(matchedHtml).toString("base64url") },
      },
    },
    "broken-alert": {
      id: "broken-alert",
      internalDate: String(Date.parse("2026-07-20T06:52:00.000Z")),
      snippet: "A transaction that the parser cannot read",
      payload: {
        headers: [
          { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
          { name: "Subject", value: "Your transaction update" },
        ],
        mimeType: "text/html",
        body: { data: Buffer.from("<p>PRIVATE BROKEN BODY</p>").toString("base64url") },
      },
    },
    "points-email": {
      id: "points-email",
      internalDate: String(Date.parse("2026-07-20T06:53:00.000Z")),
      snippet: "Your One-Time Password for INR 237.00 at Blinkit is: 673217",
      payload: {
        headers: [
          { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
          { name: "Subject", value: "Your SafeKey One-Time Password to complete your online purchase" },
        ],
      },
    },
  };
  insertRawTransaction(db, {
    source: "amex",
    amount: 327,
    currency: "INR",
    merchant_raw: "Aladdin Shawarma",
    occurred_at: "2026-07-20T06:51:00.000Z",
    card_last4: "41001",
    raw_email_id: "matched-alert",
  });
  setContext(db, "unparseable_gmail_message_ids", JSON.stringify(["broken-alert"]));
  setContext(db, "last_gmail_poll", String(Date.parse("2026-07-20T06:50:00.000Z") / 1000));
  setContext(db, "gmail_sync_alert_state", JSON.stringify({ status: "healthy" }));

  let listQuery = "";
  const gmail = {
    users: {
      messages: {
        list: async (args) => {
          listQuery = args.q;
          return { data: { messages: Object.keys(messages).map((id) => ({ id })) } };
        },
        get: async ({ id }) => ({ data: messages[id] }),
      },
    },
  };

  const result = await searchTransactionEmails(
    db,
    { provider: "amex", start_date: "2026-07-20", end_date: "2026-07-20", limit: 10 },
    { gmail, now: new Date("2026-07-20T12:00:00.000Z") }
  );

  assert.match(listQuery, /^from:\(AmericanExpress@welcome\.americanexpress\.com\) after:\d+ before:\d+$/);
  assert.equal(result.count, 3);
  assert.equal(result.poller.last_successful_poll_at, "2026-07-20T06:50:00.000Z");
  assert.equal(result.poller.sync_status, "healthy");
  const matched = result.messages.find((message) => message.message_id === "matched-alert");
  assert.equal(matched.parser_status, "matched");
  assert.equal(matched.storage_status, "ingested");
  assert.equal(matched.parsed_transaction.merchant_raw, "Aladdin Shawarma");
  const broken = result.messages.find((message) => message.message_id === "broken-alert");
  assert.equal(broken.parser_status, "unparseable");
  assert.equal(broken.storage_status, "retry_pending");
  const ignored = result.messages.find((message) => message.message_id === "points-email");
  assert.equal(ignored.parser_status, "ignored");
  assert.equal(ignored.storage_status, "ignored");
  assert.equal(ignored.snippet, "");
  assert.doesNotMatch(JSON.stringify(result), /673217|One-Time Password for INR/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY|PRIVATE BROKEN BODY/);
  db.close();
});

test("Gmail diagnostics reject broad mailbox windows", async () => {
  const db = makeDb();
  await assert.rejects(
    searchTransactionEmails(db, { start_date: "2026-01-01", end_date: "2026-07-20" }, { gmail: {} }),
    /date window cannot exceed 62 days/
  );
  db.close();
});

test("Gmail diagnostics return actionable but sanitized authorization errors", () => {
  assert.match(describeGmailDiagnosticError(new Error("invalid_grant secret=abc")), /Replace GMAIL_REFRESH_TOKEN/);
  assert.match(
    describeGmailDiagnosticError(new Error("Insufficient Permission: insufficient_scope secret=abc")),
    /gmail\.readonly/
  );
  assert.doesNotMatch(describeGmailDiagnosticError(new Error("upstream token=secret")), /secret/);
});

test("Gmail parser revision replay recovers a recent alert already marked processed", async () => {
  const db = makeDb();
  const message = {
    id: "previously-skipped-dollar-alert",
    internalDate: String(Date.parse("2026-07-16T15:13:45.000Z")),
    snippet: "Transaction Update",
    payload: {
      headers: [
        { name: "From", value: "American Express <AmericanExpress@welcome.americanexpress.com>" },
        { name: "Subject", value: "Your transaction update" },
      ],
      mimeType: "text/html",
      body: {
        data: Buffer.from(
          [
            "<p>Date:</p><p>16 July 2026</p>",
            "<p>Merchant:</p><p>Points a Plusgrade Co.</p>",
            "<p>Amount:</p><p>$50.00</p>",
            "<p>Account Ending: 41001</p>",
          ].join("")
        ).toString("base64url"),
      },
    },
  };
  setContext(db, "processed_message_ids", JSON.stringify([message.id]));
  setContext(db, "last_gmail_poll", String(Math.floor(Date.now() / 1000)));

  const gmail = {
    users: {
      messages: {
        list: async ({ q }) => {
          assert.match(q, /credit_cards@icici\.bank\.in/);
          return { data: { messages: [{ id: message.id }] } };
        },
        get: async () => ({ data: message }),
      },
    },
  };

  await pollOnce(db, {
    gmail,
    processMessageOptions: {
      enrich: async () => {},
      inferenceGenerator: async () =>
        JSON.stringify(
          inferenceProposal({
            decision: "needs_context",
            merchant_clean: "Points a Plusgrade Co.",
            treatment: "pending_forex_resolution",
            gross_amount_inr: 50,
            personal_impact: 0,
            cashflow_impact: 0,
            receivable_amount: 0,
            question: "Waiting for the final INR amount.",
          })
        ),
      sendTelegram: async () => 7654,
    },
  });

  const raw = db
    .prepare("SELECT * FROM raw_transactions WHERE raw_email_id = ?")
    .get(message.id);
  assert.ok(raw);
  assert.equal(raw.amount, 50);
  assert.equal(raw.currency, "USD");
  assert.equal(raw.is_international, 1);
  assert.equal(getContext(db, "gmail_parser_revision").value, "icici-credit-card-v1");
  db.close();
});

test("Gmail poll selection includes retries and parser-revision replay candidates", () => {
  const processed = new Set(["seen"]);
  const retries = new Set(["retry"]);
  assert.deepEqual(selectMessageIdsForPoll(["seen", "fresh"], processed, retries, false), ["fresh", "retry"]);
  assert.deepEqual(selectMessageIdsForPoll(["seen", "fresh"], processed, retries, true), ["seen", "fresh", "retry"]);
});

test("IDFC UPI parser preserves incoming-credit direction, sender, and exact time", () => {
  const body =
    "INR 800.00 credited to your IDFC FIRST Bank Account ending 3029 via UPI on 15-JUL-2026 at 01:05 PM. UPI Ref: 123456789012. VPA: nishidha@upi Sender Name: Nishidha";
  const message = {
    id: "idfc-upi-credit",
    snippet: body,
    payload: {
      headers: [
        { name: "From", value: "noreply@idfcfirstbank.com" },
        { name: "Subject", value: "Credit Alert: Your IDFC FIRST Bank Account" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };

  const parsed = parseGmailMessage(message);
  assert.ok(parsed);
  assert.equal(parsed.source, "idfc_upi");
  assert.equal(parsed.direction, "credit");
  assert.equal(parsed.correlation_status, "none");
  assert.equal(parsed.amount, 800);
  assert.equal(parsed.merchant_raw, "Nishidha");
  assert.equal(parsed.datetime, "2026-07-15T07:35:00.000Z");
});

test("AI-proposed combined repayment and surplus waits for Telegram approval, then reconciles atomically", async () => {
  const db = makeDb();
  const paperAndPieEntry = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    occurred_at: "2026-07-14T12:00:00+05:30",
    source: "bobcard",
    card_cycle_start: "2026-06-22",
    card_cycle_end: "2026-07-21",
    treatment: "split",
    gross_amount_inr: 1018.5,
    personal_impact: 468.5,
    cashflow_impact: 1018.5,
    receivable_amount: 550,
    created_by: "test",
  });
  const groceriesEntry = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    occurred_at: "2026-07-13T12:00:00+05:30",
    source: "amex",
    card_cycle_start: "2026-06-21",
    card_cycle_end: "2026-07-20",
    treatment: "split",
    gross_amount_inr: 211,
    personal_impact: 0,
    cashflow_impact: 211,
    receivable_amount: 211,
    created_by: "test",
  });
  const paperAndPie = createReceivable(db, {
    envelope_entry_id: paperAndPieEntry.id,
    counterparty: "Nishidha",
    label: "Paper and Pie split",
    amount_inr: 550,
    created_by: "test",
  });
  const groceries = createReceivable(db, {
    envelope_entry_id: groceriesEntry.id,
    counterparty: "Nishidha",
    label: "Groceries",
    amount_inr: 211,
    created_by: "test",
  });
  const raw = insertRawTransaction(db, {
    source: "idfc_upi",
    amount: 800,
    amount_inr: 800,
    merchant_raw: "Nishidha",
    occurred_at: "2026-07-15T13:05:00+05:30",
    direction: "credit",
    raw_email_id: "nishidha-800",
  });
  const allocations = [
    { receivable_id: paperAndPie.id, kind: "receivable_settlement", amount_inr: 550, notes: null },
    { receivable_id: groceries.id, kind: "receivable_settlement", amount_inr: 211, notes: null },
    { receivable_id: null, kind: "unallocated_surplus", amount_inr: 39, notes: "Possible convenience surplus" },
  ];

  const outcome = await inferRawTransaction(db, raw.id, {
    generate: async () =>
      inferenceProposal({
        decision: "needs_context",
        merchant_clean: "Nishidha",
        treatment: "receivable_settlement_with_surplus",
        gross_amount_inr: 800,
        personal_impact: 0,
        cashflow_impact: -800,
        receivable_amount: 0,
        confidence: 0.96,
        question:
          "Nishidha sent ₹800. This could settle ₹550 for Paper & Pie and ₹211 for groceries, leaving ₹39 surplus. Confirm?",
        credit_allocations: allocations,
      }),
  });
  assert.equal(outcome.status, "needs_context");
  assert.equal(listReceivables(db).length, 2);
  assert.equal(listEnvelopeEntries(db, { raw_transaction_id: raw.id }).length, 0);
  const proposed = listContextFacts(db, {
    scope_type: "transaction",
    scope_id: raw.id,
    key: "credit_allocation",
  })[0];
  assert.equal(JSON.parse(proposed.value).status, "proposed");
  assert.equal(JSON.parse(proposed.value).allocations[2].amount_inr, 39);

  let telegramText = "";
  const sent = await notifyPendingCreditInferences(db, async (text) => {
    telegramText = text;
    return 4444;
  });
  assert.equal(sent, 1);
  assert.match(telegramText, /Money received · IDFC UPI/);
  assert.match(telegramText, /leaving ₹39 surplus/);
  assert.equal(await notifyPendingCreditInferences(db, async () => 5555), 0);

  const confirmed = recordConfirmedCreditAllocation(db, {
    raw_transaction_id: raw.id,
    allocations,
    treatment: "receivable_settlement_with_surplus",
    personal_impact: 0,
    cashflow_impact: -800,
    notes: "User confirmed both repayments and the intentional ₹39 surplus.",
    created_by: "telegram_user",
  });
  assert.equal(confirmed.entry.personal_impact, 0);
  assert.equal(confirmed.entry.cashflow_impact, -800);
  assert.equal(listReceivables(db).length, 0);
  assert.equal(listReceivables(db, { include_closed: true }).every((item) => item.status === "received"), true);
  const stored = listContextFacts(db, {
    scope_type: "transaction",
    scope_id: raw.id,
    key: "credit_allocation",
  })[0];
  assert.equal(JSON.parse(stored.value).status, "confirmed");
  assert.equal(JSON.parse(stored.value).allocations[2].kind, "unallocated_surplus");
  assert.equal(aggregateSpendMonth(db, { spend_month: "2026-07" }).personal_impact, 468.5);
  db.close();
});

test("counterparty balance keeps original expenses and standalone payments visible", () => {
  const db = makeDb();

  function addReceivable(label, amount, received = 0, createdBy = "telegram_user") {
    const raw = insertRawTransaction(db, {
      source: "amex",
      amount,
      amount_inr: amount,
      merchant_raw: label,
      occurred_at: "2026-07-24T12:00:00+05:30",
      direction: "debit",
      raw_email_id: `expense-${label}`,
    });
    const entry = createEnvelopeEntry(db, {
      raw_transaction_id: raw.id,
      funding_month: "2026-08",
      occurred_at: raw.occurred_at,
      source: raw.source,
      merchant_clean: label,
      treatment: "split",
      gross_amount_inr: amount * 2,
      personal_impact: amount,
      cashflow_impact: amount * 2,
      receivable_amount: amount,
      created_by: createdBy,
    });
    return createReceivable(db, {
      envelope_entry_id: entry.id,
      counterparty: "Nishidha",
      label,
      amount_inr: amount,
      received_inr: received,
      created_by: createdBy,
    });
  }

  addReceivable("BookMyShow tickets", 3294.92, 1271.67);
  addReceivable("Bloom Hotel", 1908.43);
  addReceivable("Toscano", 1228.33, 1228.33);
  addReceivable("Paper & Pie", 550, 550);
  addReceivable("Instamart", 211, 211);
  addReceivable("Mr Chan", 51, 51);
  const inferred = addReceivable("Unexplained ₹214", 214, 0, "automatic_inference");

  const payments = [
    ["2026-07-14", 550],
    ["2026-07-14", 211],
    ["2026-07-24", 2500],
    ["2026-07-25", 51],
  ];
  for (const [date, amount] of payments) {
    const raw = insertRawTransaction(db, {
      source: "idfc_upi",
      amount,
      amount_inr: amount,
      merchant_raw: "NISHIDHA",
      occurred_at: `${date}T12:00:00+05:30`,
      direction: "credit",
      raw_email_id: `nishidha-${date}-${amount}`,
    });
    setContextFact(db, {
      scope_type: "transaction",
      scope_id: raw.id,
      key: "credit_allocation",
      value: JSON.stringify({
        status: "confirmed",
        amount_inr: amount,
        allocations: [{ receivable_id: null, kind: "legacy", amount_inr: amount }],
        notes: "Legacy allocation details must not affect the personal balance view.",
      }),
      source: "telegram_user",
      confidence: 1,
    });
  }

  setContextFact(db, {
    scope_type: "person",
    scope_id: "Nishidha",
    key: "counterparty_payable_the_odyssey_2026-07-26",
    value: JSON.stringify({
      status: "outstanding",
      label: "The Odyssey tickets",
      amount_owed_inr: 3791.33,
      recorded_on: "2026-07-26",
    }),
    source: "telegram_user",
    confidence: 1,
  });

  const summary = getCounterpartyBalance(db, "nishidha");
  assert.equal(summary.total_from_user_inr, 7243.68);
  assert.equal(summary.total_from_counterparty_inr, 7103.33);
  assert.equal(summary.net_balance_inr, 140.35);
  assert.equal(summary.result, "counterparty_owes_user");
  assert.equal(summary.value_from_user.find((item) => item.label === "Toscano").amount_inr, 1228.33);
  assert.equal(
    summary.value_from_user.find((item) => item.label === "BookMyShow tickets").amount_inr,
    3294.92
  );
  assert.equal(
    summary.value_from_counterparty.filter((item) => item.amount_inr === 2500).length,
    1
  );
  assert.equal(summary.uncertain.length, 1);
  assert.equal(summary.uncertain[0].source_id, inferred.id);
  assert.match(summary.uncertain[0].reason, /automatic inference/i);
  db.close();
});

test("counterparty transfers are standalone facts and never mutate personal receivables", () => {
  const db = makeDb();
  const expenseEntry = createEnvelopeEntry(db, {
    funding_month: "2026-08",
    occurred_at: "2026-07-24T12:00:00+05:30",
    source: "amex",
    merchant_clean: "Dinner",
    treatment: "split",
    gross_amount_inr: 2000,
    personal_impact: 1000,
    cashflow_impact: 2000,
    receivable_amount: 1000,
    created_by: "telegram_user",
  });
  const receivable = createReceivable(db, {
    envelope_entry_id: expenseEntry.id,
    counterparty: "Nishidha",
    label: "Dinner share",
    amount_inr: 1000,
    created_by: "telegram_user",
  });
  const raw = insertRawTransaction(db, {
    source: "idfc_upi",
    amount: 800,
    amount_inr: 800,
    merchant_raw: "Nishidha",
    occurred_at: "2026-07-25T12:00:00+05:30",
    direction: "credit",
    raw_email_id: "standalone-nishidha-payment",
  });
  setContextFact(db, {
    scope_type: "transaction",
    scope_id: raw.id,
    key: "counterparty_transfer",
    value: JSON.stringify({
      status: "confirmed",
      counterparty: "Nishidha",
      direction: "from_counterparty",
      amount_inr: 800,
      label: "Money received",
    }),
    source: "telegram_user",
    confidence: 1,
  });

  const summary = getCounterpartyBalance(db, "Nishidha");
  assert.equal(summary.total_from_user_inr, 1000);
  assert.equal(summary.total_from_counterparty_inr, 800);
  assert.equal(summary.net_balance_inr, 200);
  assert.equal(listReceivables(db, { counterparty: "Nishidha" })[0].received_inr, 0);
  assert.equal(listReceivables(db, { counterparty: "Nishidha" })[0].id, receivable.id);
  db.close();
});

test("off-account purchases affect the envelope while later covered expenses only offset the counterparty net", () => {
  const db = makeDb();
  const plan = createFlexBudgetPlan(db, {
    label: "Two-day flex plan",
    start_date: "2026-07-26",
    end_date: "2026-07-27",
    total_target_inr: 10000,
    created_by: "telegram_user",
    periods: [
      {
        label: "Current period",
        start_date: "2026-07-26",
        end_date: "2026-07-27",
        target_inr: 10000,
      },
    ],
  });

  const odysseyRaw = insertRawTransaction(db, {
    source: "manual",
    amount: 5687,
    amount_inr: 5687,
    merchant_raw: "The Odyssey tickets",
    occurred_at: "2026-07-26T12:00:00+05:30",
    direction: "debit",
    raw_payload: JSON.stringify({
      evidence_source: "user_report",
      paid_by: "Nishidha",
      user_share_inr: 3791.33,
    }),
  });
  const odysseyEntry = createEnvelopeEntry(db, {
    raw_transaction_id: odysseyRaw.id,
    funding_month: "2026-07",
    occurred_at: odysseyRaw.occurred_at,
    source: "manual",
    merchant_clean: "The Odyssey tickets",
    category: "Entertainment",
    treatment: "split",
    gross_amount_inr: 5687,
    personal_impact: 3791.33,
    cashflow_impact: 0,
    receivable_amount: 0,
    created_by: "telegram_user",
  });
  setFlexBudgetClassification(db, {
    plan_id: plan.id,
    raw_transaction_id: odysseyRaw.id,
    classification: "flex",
    rationale: "The user's share of the tickets is discretionary spending.",
    created_by: "telegram_user",
  });
  setContextFact(db, {
    scope_type: "person",
    scope_id: "Nishidha",
    key: "counterparty_payable_the_odyssey_2026-07-26",
    value: JSON.stringify({
      status: "outstanding",
      label: "The Odyssey tickets",
      amount_owed_inr: 3791.33,
      recorded_on: "2026-07-26",
      raw_transaction_id: odysseyRaw.id,
      envelope_entry_id: odysseyEntry.id,
      notes: "Nishidha paid; Aniket owes two-thirds.",
    }),
    source: "telegram_user",
    confidence: 1,
  });

  const dinnerRaw = insertRawTransaction(db, {
    source: "amex",
    amount: 6000,
    amount_inr: 6000,
    merchant_raw: "Dinner",
    occurred_at: "2026-07-27T20:00:00+05:30",
    direction: "debit",
  });
  const dinnerEntry = createEnvelopeEntry(db, {
    raw_transaction_id: dinnerRaw.id,
    funding_month: "2026-09",
    occurred_at: dinnerRaw.occurred_at,
    source: "amex",
    card_cycle_start: "2026-07-21",
    card_cycle_end: "2026-08-20",
    merchant_clean: "Dinner",
    category: "Dining",
    treatment: "split",
    gross_amount_inr: 6000,
    personal_impact: 3000,
    cashflow_impact: 6000,
    receivable_amount: 3000,
    created_by: "telegram_user",
  });
  createReceivable(db, {
    envelope_entry_id: dinnerEntry.id,
    counterparty: "Nishidha",
    label: "Dinner share",
    amount_inr: 3000,
    created_by: "telegram_user",
  });
  setFlexBudgetClassification(db, {
    plan_id: plan.id,
    raw_transaction_id: dinnerRaw.id,
    classification: "flex",
    rationale: "Only Aniket's share consumes the flex budget.",
    created_by: "telegram_user",
  });

  const julySpend = aggregateSpendMonth(db, { spend_month: "2026-07" });
  assert.equal(julySpend.personal_impact, 3791.33);
  assert.equal(julySpend.cashflow_impact, 0);

  const balance = getCounterpartyBalance(db, "Nishidha");
  assert.equal(balance.total_from_user_inr, 3000);
  assert.equal(balance.total_from_counterparty_inr, 3791.33);
  assert.equal(balance.net_balance_inr, -791.33);
  assert.equal(balance.result, "user_owes_counterparty");
  assert.equal(balance.value_from_counterparty[0].raw_transaction_id, odysseyRaw.id);

  const flex = getFlexBudgetStatus(db, { plan_id: plan.id, as_of: "2026-07-27" });
  assert.equal(flex.exact, true);
  assert.equal(flex.plan_spent_inr, 6791.33);
  assert.equal(flex.plan_remaining_inr, 3208.67);
  assert.equal(flex.transactions.length, 2);
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
    ["icici_cc", "2026-07-20T12:00:00+05:30", "2026-06-21", "2026-07-20", "2026-08-07", "2026-08"],
    ["icici_cc", "2026-07-21T12:00:00+05:30", "2026-07-21", "2026-08-20", "2026-09-07", "2026-09"],
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
  const plan = createFlexBudgetPlan(db, {
    label: "Inference flex plan",
    start_date: "2026-07-21",
    end_date: "2026-08-20",
    total_target_inr: 10000,
    created_by: "test",
    periods: [
      { label: "Cycle", start_date: "2026-07-21", end_date: "2026-08-20", target_inr: 10000 },
    ],
  });
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
    return inferenceProposal({
      flex_classification: "flex",
      flex_reason: "Discretionary personal purchase",
    });
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
  const flex = getFlexBudgetStatus(db, { plan_id: plan.id, as_of: "2026-07-21" });
  assert.equal(flex.exact, true);
  assert.equal(flex.plan_spent_inr, 1000);
  assert.equal(flex.transactions[0].classification, "flex");
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
  const validCredit = parseInferenceResponse(
    JSON.stringify(
      inferenceProposal({
        decision: "needs_context",
        credit_allocations: [
          { receivable_id: "receivable-1", kind: "receivable_settlement", amount_inr: 550, notes: null },
          { receivable_id: null, kind: "unallocated_surplus", amount_inr: 39, notes: "Confirm surplus" },
        ],
      })
    )
  );
  assert.equal(validCredit.credit_allocations.length, 2);
  assert.equal(
    parseInferenceResponse(
      JSON.stringify(
        inferenceProposal({
          credit_allocations: [{ receivable_id: null, kind: "surplus", amount_inr: -1, notes: null }],
        })
      )
    ),
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
  assert.doesNotMatch(telegramText, /funding month/);
  assert.match(telegramText, /June 2026 spending envelope/);
  assert.doesNotMatch(telegramText, /personal envelope remaining/);
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

test("flex budget status reproduces daily slices, split shares, and period rollover deterministically", () => {
  const db = makeDb();
  const plan = createFlexBudgetPlan(db, {
    label: "₹45k flex challenge",
    start_date: "2026-07-23",
    end_date: "2026-08-20",
    total_target_inr: 45000,
    daily_mode: "equal_slice",
    release_balance_on_last_day: true,
    policy_notes: "Fixed commitments stay outside flex. Discretionary splits count at personal share.",
    created_by: "telegram_user",
    periods: [
      { label: "23–26 Jul stub", start_date: "2026-07-23", end_date: "2026-07-26", target_inr: 6000 },
      { label: "27 Jul–2 Aug", start_date: "2026-07-27", end_date: "2026-08-02", target_inr: 11000 },
      { label: "3–9 Aug", start_date: "2026-08-03", end_date: "2026-08-09", target_inr: 11000 },
      { label: "10–16 Aug", start_date: "2026-08-10", end_date: "2026-08-16", target_inr: 11000 },
      { label: "17–20 Aug stub", start_date: "2026-08-17", end_date: "2026-08-20", target_inr: 6000 },
    ],
  });

  function add(data) {
    const transaction = insertTestTransaction(db, {
      source: data.source || "amex",
      amount: data.gross,
      merchant_raw: data.merchant,
      datetime: `${data.date}T12:00:00+05:30`,
      currency: "INR",
    });
    const entry = createEnvelopeEntry(db, {
      raw_transaction_id: transaction.id,
      funding_month: "2026-09",
      occurred_at: transaction.datetime,
      source: transaction.source,
      merchant_clean: data.merchant,
      category: data.category || "Other",
      treatment: data.treatment || "normal",
      state: "actual",
      gross_amount_inr: data.gross,
      personal_impact: data.personal,
      cashflow_impact: data.gross,
      receivable_amount: Math.max(0, data.gross - data.personal),
      created_by: "test",
    });
    setFlexBudgetClassification(db, {
      plan_id: plan.id,
      raw_transaction_id: transaction.id,
      classification: data.classification,
      rationale: data.reason || "test decision",
      confidence: 1,
      created_by: "test",
    });
    return { transaction, entry };
  }

  add({ date: "2026-07-23", merchant: "Instamart", gross: 765, personal: 765, classification: "flex" });
  add({
    date: "2026-07-23",
    merchant: "Anthropic",
    gross: 2277,
    personal: 2277,
    treatment: "committed",
    classification: "fixed",
  });
  add({ date: "2026-07-24", merchant: "Bistro", gross: 326, personal: 326, classification: "flex" });
  add({ date: "2026-07-24", merchant: "Swiggy lunch", gross: 634, personal: 634, classification: "flex" });
  const grocery = add({
    date: "2026-07-24",
    merchant: "Instamart groceries",
    gross: 335,
    personal: 335,
    classification: "flex",
  });

  const friday = getFlexBudgetStatus(db, { plan_id: plan.id, as_of: "2026-07-24" });
  assert.equal(friday.exact, true);
  assert.equal(friday.plan_spent_inr, 2060);
  assert.equal(friday.current_period.spent_inr, 2060);
  assert.equal(friday.current_period.remaining_inr, 3940);
  assert.equal(friday.today.nominal_target_inr, 1500);
  assert.equal(friday.today.spent_inr, 1295);
  assert.equal(friday.today.remaining_inr, 205);

  const fridayAlert = formatV2Transaction(grocery.transaction, {
    status: "interpreted",
    entry: grocery.entry,
    flex_budget: friday,
  });
  assert.match(fridayAlert, /Flex left: ₹205 today · ₹3,940 23–26 Jul stub/);

  const sundayBeforeMoreSpend = getFlexBudgetStatus(db, {
    plan_id: plan.id,
    as_of: "2026-07-26",
  });
  assert.equal(sundayBeforeMoreSpend.today.is_period_last_day, true);
  assert.equal(sundayBeforeMoreSpend.today.remaining_inr, 3940);

  add({
    date: "2026-07-24",
    merchant: "Bloom Hotels",
    gross: 3816.87,
    personal: 1908.44,
    treatment: "split",
    classification: "flex",
  });
  add({
    date: "2026-07-24",
    merchant: "BookMyShow",
    gross: 6589.84,
    personal: 3294.92,
    treatment: "split",
    classification: "flex",
  });
  add({
    date: "2026-07-25",
    merchant: "New Topin Town",
    gross: 199,
    personal: 199,
    source: "bobcard",
    classification: "flex",
  });

  const sunday = getFlexBudgetStatus(db, { plan_id: plan.id, as_of: "2026-07-26" });
  assert.equal(sunday.plan_spent_inr, 7462.36);
  assert.equal(sunday.current_period.remaining_inr, -1462.36);
  assert.equal(sunday.current_period.available_inr, 0);
  assert.equal(sunday.today.remaining_inr, 0);
  assert.equal(sunday.periods[1].adjusted_target_inr, 9537.64);
  assert.equal(sunday.periods[2].adjusted_target_inr, 11000);
  assert.equal(sunday.plan_remaining_inr, 37537.64);

  insertTestTransaction(db, {
    source: "amex",
    amount: 599,
    merchant_raw: "HAMLEYS",
    datetime: "2026-07-25T14:40:00+05:30",
    currency: "INR",
  });
  const incomplete = getFlexBudgetStatus(db, { plan_id: plan.id, as_of: "2026-07-26" });
  assert.equal(incomplete.exact, false);
  assert.equal(incomplete.unresolved.length, 1);
  assert.equal(incomplete.unresolved[0].reason, "awaiting_interpretation");
  db.close();
});

test("flex budget plans reject gaps and target drift", () => {
  const db = makeDb();
  assert.throws(
    () =>
      createFlexBudgetPlan(db, {
        label: "Broken plan",
        start_date: "2026-07-23",
        end_date: "2026-07-26",
        total_target_inr: 6000,
        created_by: "test",
        periods: [
          { label: "Gap", start_date: "2026-07-24", end_date: "2026-07-26", target_inr: 5000 },
        ],
      }),
    /ordered, contiguous/
  );
  assert.throws(
    () =>
      createFlexBudgetPlan(db, {
        label: "Bad total",
        start_date: "2026-07-23",
        end_date: "2026-07-26",
        total_target_inr: 6000,
        created_by: "test",
        periods: [
          { label: "Stub", start_date: "2026-07-23", end_date: "2026-07-26", target_inr: 5999 },
        ],
      }),
    /add up/
  );
  db.close();
});

test("revising a flex budget preserves existing AI classifications", () => {
  const db = makeDb();
  const original = createFlexBudgetPlan(db, {
    label: "₹40k plan",
    start_date: "2026-07-23",
    end_date: "2026-07-26",
    total_target_inr: 40000,
    created_by: "telegram_user",
    periods: [
      { label: "Stub", start_date: "2026-07-23", end_date: "2026-07-26", target_inr: 40000 },
    ],
  });
  const raw = insertTestTransaction(db, {
    source: "amex",
    amount: 765,
    merchant_raw: "INSTAMART",
    datetime: "2026-07-23T12:00:00+05:30",
    currency: "INR",
  });
  createEnvelopeEntry(db, {
    raw_transaction_id: raw.id,
    funding_month: "2026-09",
    occurred_at: raw.datetime,
    source: raw.source,
    treatment: "normal",
    gross_amount_inr: 765,
    personal_impact: 765,
    cashflow_impact: 765,
    created_by: "test",
  });
  setFlexBudgetClassification(db, {
    plan_id: original.id,
    raw_transaction_id: raw.id,
    classification: "flex",
    rationale: "Groceries belong to this challenge",
    created_by: "test",
  });

  const revised = createFlexBudgetPlan(db, {
    label: "₹45k plan",
    start_date: "2026-07-23",
    end_date: "2026-07-26",
    total_target_inr: 45000,
    created_by: "telegram_user",
    supersedes_id: original.id,
    periods: [
      { label: "Stub", start_date: "2026-07-23", end_date: "2026-07-26", target_inr: 45000 },
    ],
  });
  const status = getFlexBudgetStatus(db, { plan_id: revised.id, as_of: "2026-07-23" });
  assert.equal(status.exact, true);
  assert.equal(status.plan_spent_inr, 765);
  assert.equal(status.transactions[0].classification, "flex");
  assert.equal(
    db.prepare("SELECT status, replaced_by_id FROM flex_budget_plans WHERE id = ?").get(original.id).status,
    "superseded"
  );
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
    "get_spend_month_summary",
    "get_funding_summary",
    "create_flex_budget_plan",
    "list_flex_budget_plans",
    "get_active_flex_budget_plan",
    "set_flex_budget_classification",
    "get_flex_budget_status",
    "set_context_fact",
    "list_context_facts",
    "create_receivable",
    "update_receivable",
    "list_receivables",
    "get_counterparty_balance",
    "record_confirmed_credit_allocation",
    "create_commitment",
    "update_commitment",
    "list_commitments_v2",
  ];
  for (const name of expected) findTool(name);
  assert.equal(
    findTool("get_card_cycle_for_date").parameters.properties.source.enum.includes("icici_cc"),
    true
  );
  assert.equal(
    findTool("create_raw_transaction").parameters.properties.source.enum.includes("icici_cc"),
    true
  );
  assert.equal(
    findTool("create_raw_transaction").parameters.properties.source.enum.includes("manual"),
    true
  );
});

test("production MCP surface exposes v2 finance tools and no legacy envelope mutators", () => {
  const names = buildMcpToolSpecs().map((spec) => spec.name);
  assert.equal(names.includes("interpret_pending_transactions"), true);
  assert.equal(names.includes("get_counterparty_balance"), true);
  assert.equal(names.includes("search_transaction_emails"), true);
  assert.equal(names.includes("post_agent_message"), true);
  assert.equal(names.includes("get_envelope"), false);
  assert.equal(names.includes("recalculate_envelope"), false);
  assert.equal(names.includes("create_transaction"), false);
});

test("health metadata reads the deployed package version", () => {
  assert.equal(PACKAGE_VERSION, require("../package.json").version);
});

test("health reports the next enabled cron and per-scheduler timing", async () => {
  resetSchedulerHealthForTests();
  configureScheduler("gmail_poll", { label: "Gmail", interval_minutes: 5, enabled: true });
  configureScheduler("automatic_inference", { label: "Inference", interval_minutes: 5, enabled: false });

  const now = new Date("2026-07-14T10:12:34.000Z");
  assert.equal(nextCronTick(5, now).toISOString(), "2026-07-14T10:15:00.000Z");
  const snapshot = getSchedulerHealth(now);
  assert.equal(snapshot.next_cron_at, "2026-07-14T10:15:00.000Z");
  assert.equal(snapshot.next_cron_in_seconds, 146);
  assert.equal(snapshot.schedulers.gmail_poll.next_run_at, "2026-07-14T10:15:00.000Z");
  assert.equal(snapshot.schedulers.automatic_inference.next_run_at, null);
  assert.equal(snapshot.schedulers.automatic_inference.next_tick_at, "2026-07-14T10:15:00.000Z");

  const db = makeDb();
  const app = require("fastify")();
  registerRoutes(app, db);
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const health = response.json();
  assert.equal(typeof health.checked_at, "string");
  assert.equal(typeof health.next_cron_at, "string");
  assert.equal(health.schedulers.gmail_poll.enabled, true);
  assert.equal(health.schedulers.automatic_inference.enabled, false);
  await app.close();
  db.close();
  resetSchedulerHealthForTests();
});

test("health degrades for an enabled failed scheduler and recovers after success", async () => {
  resetSchedulerHealthForTests();
  configureScheduler("gmail_poll", { label: "Gmail", interval_minutes: 5, enabled: true });
  await runSchedulerCycle("gmail_poll", async () => {
    throw new Error("invalid_grant");
  });

  const db = makeDb();
  const app = require("fastify")();
  registerRoutes(app, db);

  const degradedResponse = await app.inject({ method: "GET", url: "/health" });
  assert.equal(degradedResponse.statusCode, 503);
  const degraded = degradedResponse.json();
  assert.equal(degraded.status, "degraded");
  assert.deepEqual(degraded.degraded_components, ["gmail_poll"]);
  assert.equal(degraded.schedulers.gmail_poll.last_outcome, "error");
  assert.equal(degraded.schedulers.gmail_poll.last_error, "invalid_grant");

  await runSchedulerCycle("gmail_poll", async () => {});
  const recoveredResponse = await app.inject({ method: "GET", url: "/health" });
  assert.equal(recoveredResponse.statusCode, 200);
  const recovered = recoveredResponse.json();
  assert.equal(recovered.status, "ok");
  assert.deepEqual(recovered.degraded_components, []);
  assert.equal(recovered.schedulers.gmail_poll.last_outcome, "success");
  assert.equal(recovered.schedulers.gmail_poll.last_error, null);

  await app.close();
  db.close();
  resetSchedulerHealthForTests();
});

test("Gmail poll failures and recovery send one operational Telegram alert each", async () => {
  const db = makeDb();
  const messages = [];
  const sendTelegram = async (message) => {
    messages.push(message);
    return messages.length;
  };
  const failPoll = async () => {
    throw new Error("invalid_grant");
  };

  await assert.rejects(
    runGmailPollCycle(db, { poll: failPoll, sendTelegram }),
    /invalid_grant/
  );
  await assert.rejects(
    runGmailPollCycle(db, { poll: failPoll, sendTelegram }),
    /invalid_grant/
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Gmail transaction sync is down/);
  assert.match(messages[0], /Replace GMAIL_REFRESH_TOKEN/);

  await runGmailPollCycle(db, { poll: async () => {}, sendTelegram });
  await runGmailPollCycle(db, { poll: async () => {}, sendTelegram });
  assert.equal(messages.length, 2);
  assert.match(messages[1], /Gmail transaction sync recovered/);
  assert.equal(JSON.parse(getContext(db, "gmail_sync_alert_state").value).status, "healthy");

  await assert.rejects(
    runGmailPollCycle(db, {
      poll: async () => {
        throw new Error("Insufficient Permission");
      },
      sendTelegram,
    }),
    /Insufficient Permission/
  );
  assert.equal(messages.length, 3);
  assert.match(messages[2], /gmail\.readonly/);
  db.close();
});

test("Violet is required to query raw storage for recent transaction questions", () => {
  const db = makeDb();
  const prompt = buildSystemPrompt(db);
  assert.match(prompt, /latest, newest, recent, or missing transaction, always call get_raw_transactions/);
  assert.match(
    prompt,
    /daily allowance, weekly\/period allowance, flex spend, challenge progress, or remaining flex budget, call get_flex_budget_status/
  );
  assert.match(prompt, /call get_counterparty_balance immediately before answering/);
  assert.match(prompt, /person-to-person payment is a standalone event, not an invoice allocation/);
  assert.match(prompt, /source=manual raw transaction for the reported purchase event/);
  assert.match(prompt, /cashflow_impact=0/);
  assert.match(prompt, /independent opposite-side event/);
  assert.match(prompt, /Never blame the user's phrasing/);
  assert.doesNotMatch(prompt, /slightly witty/);
  db.close();
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
