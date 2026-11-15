require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { parseGmailMessage } = require("../src/gmail/parsers");
const { isAmexSender, TRANSACTION_SENDERS } = require("../src/gmail/senders");
const {
  pollOnce,
  processMessage,
  isLikelyTransactionAlert,
} = require("../src/gmail/poller");
const { searchTransactionEmails } = require("../src/gmail/diagnostics");
const { runMigrations } = require("../src/db/schema");
const { insertRawTransaction } = require("../src/db/v2-queries");
const { recordTransactionEvidence } = require("../src/db/evidence");
const { setContext, getContext } = require("../src/db/queries");
process.env.TELEGRAM_CHAT_ID = "-100000007";

// Synthetic structural fixture: each label/value lives in a separate nested
// presentation table, as in the newer template. There are no paragraphs.
function modernHtml({
  date = "12-03-2031",
  amount = "INR 321.45",
  merchant = "EXAMPLE STORE",
  extra = "",
} = {}) {
  const row = (key, value) =>
    `<tr><td><table><tr><td><span>${key}:</span></td></tr></table><table><tr><td><strong>${value}</strong></td></tr></table></td></tr>`;
  return `<table><tr><td>Account ending: <b>0007</b></td></tr>${row("Date", date)}${row("Merchant", merchant)}${row("Amount", amount)}${extra}</table>`;
}
function message({
  id = "new-amex-alert",
  html = modernHtml(),
  sender = TRANSACTION_SENDERS.amex[1],
  subject = "Your transaction update",
  received = "2031-03-12T04:12:30.000Z",
} = {}) {
  return {
    id,
    internalDate: String(Date.parse(received)),
    payload: {
      headers: [
        { name: "From", value: `American Express <${sender}>` },
        { name: "Subject", value: subject },
      ],
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/html",
          body: { data: Buffer.from(html).toString("base64url") },
        },
      ],
    },
  };
}
function dbFor(t) {
  const db = new Database(":memory:");
  runMigrations(db);
  t.after(() => db.close());
  return db;
}
const noEffects = {
  enrich: async () => assert.fail("duplicate enrichment"),
  inferenceGenerator: async () => assert.fail("duplicate inference"),
  sendTelegram: async () => assert.fail("duplicate notification"),
};

test("both AmEx sender addresses accept old paragraphs and new nested tables", () => {
  const old =
    "<p>Date:</p><p>12 March 2031</p><p>Merchant:</p><p>EXAMPLE STORE</p><p>Amount:</p><p>INR 2,468.75</p><p>Account Ending: <b>40007</b></p>";
  for (const sender of TRANSACTION_SENDERS.amex)
    for (const html of [old, modernHtml({ amount: "INR 2,468.75" })]) {
      const m = message({ sender, html });
      const p = parseGmailMessage(m);
      assert.ok(p);
      assert.equal(p.amount, 2468.75);
      assert.equal(p.currency, "INR");
      assert.equal(p.card_last4, html === old ? "40007" : "0007");
      assert.equal(p.datetime, "2031-03-12T04:12:30.000Z");
      assert.equal(p.is_preauth, false);
      assert.equal(p.direction, "debit");
      assert.equal(isLikelyTransactionAlert(m), true);
    }
});

test("sender matching is mailbox-exact and subjects ignore case but reject OTP and forwarded alerts", () => {
  assert.equal(
    isAmexSender(
      '"American Express" <DONOTREPLY@COMMUNICATION.AMERICANEXPRESS.CO.IN>',
    ),
    true,
  );
  for (const sender of [
    "donotreply@communication.americanexpress.co.in.evil.test",
    "attacker@evil.test",
    "x@americanexpress.com",
  ]) {
    assert.equal(parseGmailMessage(message({ sender })), null);
    assert.equal(isLikelyTransactionAlert(message({ sender })), false);
  }
  assert.equal(
    isAmexSender(
      '"donotreply@communication.americanexpress.co.in" <attacker@evil.test>',
    ),
    false,
  );
  assert.ok(
    parseGmailMessage(message({ subject: " YOUR TRANSACTION UPDATE " })),
  );
  for (const subject of [
    "Your SafeKey One-Time Password",
    "Fwd: Your transaction update",
    "Your transaction update cancelled",
  ]) {
    assert.equal(parseGmailMessage(message({ subject })), null);
    assert.equal(isLikelyTransactionAlert(message({ subject })), false);
  }
});

test("new template preserves currency, decoded merchant text and issuer date across receipt-day boundaries", () => {
  const p = parseGmailMessage(
    message({
      html: modernHtml({ amount: "RM 14.57", merchant: "SHOP &amp; CAFE" }),
      received: "2031-03-13T00:30:12.345Z",
    }),
  );
  assert.equal(p.currency, "MYR");
  assert.equal(p.amount, 14.57);
  assert.equal(p.amount_inr, null);
  assert.equal(p.is_international, true);
  assert.equal(p.merchant_raw, "SHOP & CAFE");
  assert.equal(p.datetime, "2031-03-12T00:30:12.345Z");
});

test("impossible dates, missing fields and conflicting copies remain retryable rather than guessed", async (t) => {
  const db = dbFor(t);
  for (const date of [
    "31-11-2031",
    "29-02-2031",
    "12-13-2031",
    "00-03-2031",
    "31 November 2031",
    "12/03/2031",
  ]) {
    const m = message({ html: modernHtml({ date }) });
    assert.equal(parseGmailMessage(m), null, date);
    assert.equal(await processMessage(db, m, noEffects), "unparseable");
  }
  assert.ok(
    parseGmailMessage(message({ html: modernHtml({ date: "29-02-2024" }) })),
  );
  assert.equal(
    parseGmailMessage(
      message({ html: modernHtml().replace("Amount:", "Something else:") }),
    ),
    null,
  );
  assert.equal(
    parseGmailMessage(
      message({
        html: modernHtml({
          extra: "<tr><td>Amount:</td><td>INR 322.45</td></tr>",
        }),
      }),
    ),
    null,
  );
  assert.equal(
    parseGmailMessage(message({ html: modernHtml() + modernHtml() })).amount,
    321.45,
  );
});

test("new sender diagnostics and backlog share discovery rules without exposing security content", async (t) => {
  const db = dbFor(t),
    m = message({ html: modernHtml({ amount: "UNKNOWN 321.45" }) });
  let query;
  const gmail = {
    users: {
      messages: {
        list: async ({ q }) => {
          query = q;
          return { data: { messages: [{ id: m.id }] } };
        },
        get: async () => ({ data: m }),
      },
    },
  };
  await assert.rejects(
    pollOnce(db, { gmail, processMessageOptions: noEffects }),
    /unparseable/,
  );
  for (const sender of TRANSACTION_SENDERS.amex)
    assert.ok(query.includes(sender));
  assert.ok(
    JSON.parse(getContext(db, "unparseable_gmail_message_ids").value).includes(
      m.id,
    ),
  );
  const diagnostic = await searchTransactionEmails(
    db,
    { provider: "amex", start_date: "2031-03-12", end_date: "2031-03-12" },
    { gmail },
  );
  for (const sender of TRANSACTION_SENDERS.amex)
    assert.ok(query.includes(sender));
  assert.equal(diagnostic.messages[0].storage_status, "retry_pending");
  m.payload.headers[1].value = "Your SafeKey One-Time Password";
  m.snippet = "DO NOT RETURN SECURITY CONTENT";
  const security = await searchTransactionEmails(
    db,
    { provider: "amex", start_date: "2031-03-12", end_date: "2031-03-12" },
    { gmail },
  );
  assert.equal(security.messages[0].snippet, "");
  assert.equal(security.messages[0].parser_status, "ignored");
});

test("replayed new-template emails with explicit evidence preserve both manual and recovered raw-only charges", async (t) => {
  const db = dbFor(t),
    m = message();
  const raw = insertRawTransaction(db, {
    id: "canonical",
    source: "amex",
    amount: 321.45,
    merchant_raw: "EXAMPLE STORE",
    occurred_at: "2031-03-12T00:00:00+05:30",
    raw_payload: "immutable reviewed evidence",
  });
  recordTransactionEvidence(db, {
    raw_transaction_id: raw.id,
    channel: "gmail",
    external_id: m.id,
    raw_payload: "reviewed link",
  });
  setContext(db, "gmail_parser_revision", "amex-sgd-v1");
  setContext(db, "processed_message_ids", JSON.stringify([m.id]));
  setContext(db, "last_gmail_poll", String(Math.floor(Date.now() / 1000)));
  let query,
    reads = 0;
  const gmail = {
    users: {
      messages: {
        list: async ({ q }) => {
          query = q;
          return { data: { messages: [{ id: m.id }] } };
        },
        get: async () => {
          reads++;
          return { data: m };
        },
      },
    },
  };
  await pollOnce(db, { gmail, processMessageOptions: noEffects });
  assert.equal(reads, 1);
  assert.ok(
    Number(query.match(/after:(\d+)/)[1]) <=
      Math.floor(Date.now() / 1000) - 47 * 3600,
  );
  await pollOnce(db, { gmail, processMessageOptions: noEffects });
  assert.equal(reads, 1);
  assert.deepEqual(db.prepare("SELECT * FROM raw_transactions").all(), [raw]);
  assert.equal(
    db.prepare("SELECT count(*) n FROM envelope_entries").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM transactions").get().n, 0);
  const diagnostic = await searchTransactionEmails(
    db,
    { provider: "amex", start_date: "2031-03-12", end_date: "2031-03-12" },
    { gmail },
  );
  assert.equal(diagnostic.messages[0].storage_status, "ingested");
  assert.equal(diagnostic.messages[0].raw_transaction_id, raw.id);
});

test("new template ingests once with its Gmail identity and normal notification path", async (t) => {
  const db = dbFor(t),
    m = message();
  let sent = 0;
  const prior = process.env.AUTO_INFERENCE_ENABLED;
  process.env.AUTO_INFERENCE_ENABLED = "false";
  t.after(() => {
    if (prior === undefined) delete process.env.AUTO_INFERENCE_ENABLED;
    else process.env.AUTO_INFERENCE_ENABLED = prior;
  });
  const options = {
    enrich: async () => {},
    sendTelegram: async () => {
      sent++;
      return 987;
    },
  };
  assert.equal(await processMessage(db, m, options), "recorded");
  assert.equal(await processMessage(db, m, noEffects), "duplicate");
  const raw = db.prepare("SELECT * FROM raw_transactions").get();
  assert.equal(raw.raw_email_id, m.id);
  assert.equal(raw.amount, 321.45);
  assert.equal(raw.card_last4, "0007");
  assert.equal(
    db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
    1,
  );
  assert.equal(sent, 1);
});
