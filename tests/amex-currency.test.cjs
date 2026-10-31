require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { parseAmexAmount } = require("../src/gmail/parsers/amex-amount");
const { parseGmailMessage } = require("../src/gmail/parsers");
const { runMigrations } = require("../src/db/schema");
const { insertRawTransaction } = require("../src/db/v2-queries");
const { getContext, setContext } = require("../src/db/queries");
const { recordTransactionEvidence, findRawTransactionIdByEvidence } = require("../src/db/evidence");
const { pollOnce, processMessage, runGmailPollCycle } = require("../src/gmail/poller");
const { searchTransactionEmails } = require("../src/gmail/diagnostics");

function message(amount = "RM12.36", id = "test-amex-myr-alert") {
  const html = `<p>Date:</p><p>5 October 2026</p>
    <p>Merchant:</p><p>GRAB RIDES-EC</p><p>Amount:</p><p>${amount}</p>
    <p>Account Ending: 41001</p>`;
  return {
    id, internalDate: String(Date.parse("2026-10-05T03:13:01.000Z")),
    payload: {
      headers: [
        { name: "From", value: "AmericanExpress@welcome.americanexpress.com" },
        { name: "Subject", value: "Your transaction update" },
      ],
      mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") },
    },
  };
}
function makeDb(t) {
  const db = new Database(":memory:");
  runMigrations(db);
  t.after(() => db.close());
  return db;
}
function statement(db) {
  return insertRawTransaction(db, {
    id: "test-statement-charge", source: "amex", amount: 12.36, currency: "MYR",
    amount_inr: 303.91, merchant_raw: "GRAB RIDES-EC PETALING JAYA",
    occurred_at: "2026-10-05T12:00:00+05:30", card_last4: "41001",
    is_international: true, raw_email_id: "statement:test:amex",
    raw_payload: "immutable original statement evidence",
  });
}
function link(db, raw, channel = "gmail") {
  recordTransactionEvidence(db, {
    raw_transaction_id: raw.id, channel, external_id: message().id,
    raw_payload: "explicitly reviewed email-to-statement reconciliation",
  });
}
const noEffects = {
  enrich: async () => assert.fail("Reconciled email must not enrich"),
  inferenceGenerator: async () => assert.fail("Reconciled email must not infer"),
  sendTelegram: async () => assert.fail("Reconciled email must not notify as new spending"),
};

test("AmEx accepts the runtime ISO currency catalogue, including travel currencies", () => {
  const codes = Intl.supportedValuesOf("currency");
  for (const required of ["USD", "SGD", "INR", "MYR", "THB", "PHP", "JPY", "CNY",
    "KRW", "AED", "SAR", "CHF", "NZD", "IDR", "VND", "TWD"]) {
    assert.ok(codes.includes(required), required);
  }
  for (const currency of codes) {
    for (const input of [`${currency} 12.36`, `${currency.toLowerCase()}12.36`, `12.36 ${currency}`]) {
      assert.deepEqual(parseAmexAmount(input), { currency, amount: 12.36 }, input);
    }
  }
});

test("AmEx supports common aliases with or without spaces and preserves foreign amounts", () => {
  const aliases = {
    USD: ["US$", "$"], SGD: ["SG$", "S$"], INR: ["₹", "Rs.", "Rs"],
    MYR: ["RM", "rm"], THB: ["฿"], PHP: ["₱"], EUR: ["€"], GBP: ["£"],
    AUD: ["A$", "AU$"], CAD: ["C$", "CA$"], HKD: ["HK$"], NZD: ["NZ$"],
    TWD: ["NT$"], JPY: ["¥", "JP¥"], CNY: ["CN¥"],
  };
  for (const [currency, tokens] of Object.entries(aliases)) {
    for (const token of tokens) {
      for (const input of [`${token}12.36`, `${token}\u00a012.36`, `12.36 ${token}`]) {
        const parsed = parseGmailMessage(message(input));
        assert.ok(parsed, input);
        assert.equal(parsed.currency, currency, input);
        assert.equal(parsed.amount, 12.36, input);
        assert.equal(parsed.amount_inr, null, input);
        assert.equal(parsed.is_international, currency !== "INR", input);
        assert.equal(parsed.notes, currency === "INR" ? null : "pending_forex_resolution", input);
        assert.equal(parsed.datetime, "2026-10-05T03:13:01.000Z", input);
      }
    }
  }
});

test("AmEx parses only well-formed decimal-point and comma-grouped numbers", () => {
  for (const [input, amount] of [
    ["THB 1,234.50", 1234.5], ["PHP 1,234,567.89", 1234567.89],
    ["INR 1,23,456.78", 123456.78], ["MYR 0.50", 0.5],
    ["JPY 1200", 1200], ["KWD 12.345", 12.345], ["USD 0", 0],
  ]) assert.equal(parseAmexAmount(input)?.amount, amount, input);
  for (const input of ["MYR 12,36", "USD 1,23", "USD 1,234,56", "USD 12.3.6",
    "USD .", "USD ,", "USD 12.", "USD -12.36", "USD 1e3", "USD NaN",
    "USD Infinity", "USD 1 234.50", "USD 12.36 extra", "USD 12.36 MYR",
    "XYZ 12.36", "XXX 12.36", "P12.36", "kr12.36", "12.36", "MYR", "",
    `USD ${"9".repeat(400)}`]) {
    assert.equal(parseAmexAmount(input), null, input);
  }
});

test("Explicit Gmail evidence reconciles a raw-only statement without touching settled values", async (t) => {
  const db = makeDb(t);
  const raw = statement(db);
  link(db, raw);
  assert.equal(findRawTransactionIdByEvidence(db, "gmail", message().id), raw.id);
  for (let i = 0; i < 2; i++) {
    assert.equal(await processMessage(db, message(), noEffects), "duplicate");
  }
  assert.deepEqual(db.prepare("SELECT * FROM raw_transactions").all(), [raw]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM envelope_entries").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM transaction_evidence").get().n, 1);
});

test("Evidence matching is exact and channel-specific, never fuzzy merchant matching", (t) => {
  const db = makeDb(t);
  const raw = statement(db);
  link(db, raw, "sms");
  assert.equal(findRawTransactionIdByEvidence(db, "gmail", message().id), undefined);
  assert.equal(findRawTransactionIdByEvidence(db, "sms", message().id), raw.id);
  assert.equal(findRawTransactionIdByEvidence(db, "sms", "different-email"), undefined);
});

test("A linked old MYR alert clears backlog and reports recovery once without a new charge", async (t) => {
  const db = makeDb(t);
  const raw = statement(db);
  link(db, raw);
  setContext(db, "unparseable_gmail_message_ids", JSON.stringify([message().id]));
  setContext(db, "gmail_parser_revision", "amex-sgd-v1");
  setContext(db, "last_gmail_poll", String(Date.parse("2026-10-31T06:20:00Z") / 1000));
  setContext(db, "gmail_sync_alert_state", JSON.stringify({
    status: "failed", incident_kind: "parser_backlog", pending_count: 1, provider: "AmEx",
  }));
  let reads = 0;
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [] } }),
    get: async ({ id }) => { reads++; assert.equal(id, message().id); return { data: message() }; },
  } } };
  const notifications = [];
  for (let i = 0; i < 2; i++) {
    await runGmailPollCycle(db, {
      poll: () => pollOnce(db, { gmail, processMessageOptions: noEffects }),
      sendTelegram: async (text) => { notifications.push(text); return 1; },
    });
  }
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(getContext(db, "unparseable_gmail_message_ids").value), []);
  assert.ok(JSON.parse(getContext(db, "processed_message_ids").value).includes(message().id));
  assert.ok(getContext(db, "last_clean_gmail_poll"));
  assert.equal(JSON.parse(getContext(db, "gmail_sync_alert_state").value).status, "healthy");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /parser backlog cleared/);
  assert.deepEqual(db.prepare("SELECT * FROM raw_transactions").all(), [raw]);
});

test("Read-only Gmail diagnostics identify a reconciled statement as ingested", async (t) => {
  const db = makeDb(t);
  const raw = statement(db);
  link(db, raw);
  const gmail = { users: { messages: {
    list: async () => ({ data: { messages: [{ id: message().id }] } }),
    get: async () => ({ data: message() }),
  } } };
  const result = await searchTransactionEmails(db, {
    provider: "amex", start_date: "2026-10-05", end_date: "2026-10-05",
  }, { gmail, now: new Date("2026-10-31T06:30:00Z") });
  assert.equal(result.messages[0].storage_status, "ingested");
  assert.equal(result.messages[0].raw_transaction_id, raw.id);
  assert.equal(result.messages[0].parsed_transaction.currency, "MYR");
  assert.deepEqual(db.prepare("SELECT * FROM raw_transactions").all(), [raw]);
});
