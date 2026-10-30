require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { runMigrations } = require("../src/db/schema");
const {
  migrateContacts,
  ensureContact,
  findContact,
  updateContact,
  listContacts,
} = require("../src/contacts/store");
const {
  createEnvelopeEntry,
  createReceivable,
  getCounterpartyBalance,
  setContextFact,
  updateReceivable,
} = require("../src/db/v2-queries");
const {
  createContactInvite,
  claimTelegramContributorInvite,
  getTelegramRecipient,
  getActiveTelegramContributor,
  setContactAccess,
} = require("../src/telegram/access");
const {
  preparePaymentBatch,
  authorizePaymentRequests,
  getPaymentRequest,
  changeRequestState,
  currentFingerprint,
} = require("../src/payments/requests");
const { renderPaymentMessage } = require("../src/payments/messages");
const {
  deliverPaymentRequests,
  sendPaymentMessage,
  DeliveryError,
} = require("../src/payments/delivery");
const { handleRecipientMessage } = require("../src/payments/replies");
const {
  handleTelegramUpdate,
  resolveTelegramActor,
} = require("../src/telegram/bot");
const { runContributorAgent } = require("../src/agent/contributor");
const { runAgent } = require("../src/agent/runner");
const { contactTools } = require("../src/agent/contact-tools");
const { buildMcpToolSpecs } = require("../src/api/routes");

const owner = {
  role: "owner",
  actor: "test-owner",
  source: "telegram",
  request_id: "update-1",
};
const now = new Date();
const later = (seconds) => new Date(now.getTime() + seconds * 1000);
const compose = async (facts) =>
  renderPaymentMessage(facts, {
    greeting: "Hey! Hope you're well 😊",
    closing: "Thanks so much!",
  });
process.env.TELEGRAM_OWNER_USER_ID = "111";
process.env.TELEGRAM_WEBHOOK_SECRET = "unit-test-only";

function env(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function fixture(t) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  t.after(() => db.close());
  env(t, "PAYMENT_REQUEST_DELIVERY_ENABLED", "true");
  env(t, "PAYMENT_REQUEST_UPI_ID", "9969596700@ptyes");
  return db;
}

function connect(
  db,
  name = "Vee",
  user = "222",
  role = "recipient",
  extra = {},
) {
  const invite = createContactInvite(db, {
    name,
    role,
    created_by: "owner",
    now,
    ...extra,
  });
  const claim = claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: user,
    owner_telegram_user_id: "111",
    now,
    username: extra.expected_username,
  });
  return {
    contact: findContact(db, name),
    invite,
    connection: claim.contributor,
  };
}

function split(db, name = "Vee", amount = 883.71) {
  const entry = createEnvelopeEntry(db, {
    funding_month: "2026-10",
    occurred_at: "2026-10-20T12:00:00Z",
    treatment: "split",
    gross_amount_inr: 4135,
    personal_impact: 1168.46,
    cashflow_impact: 4135,
    receivable_amount: 2966.54,
    created_by: "telegram_user",
    merchant_clean: "District Dining",
    state: "actual",
  });
  const row = createReceivable(db, {
    envelope_entry_id: entry.id,
    counterparty: name,
    label: "District Dining",
    amount_inr: amount,
    created_by: "telegram_user",
  });
  return {
    contact_id: findContact(db, name).id,
    receivable_ids: [row.id],
    context: "our dinner at District Dining",
    row,
    entry,
  };
}

async function draft(db, input) {
  const batch = await preparePaymentBatch(db, [input], owner, compose, now);
  assert.equal(batch.results[0].error, undefined);
  return getPaymentRequest(db, batch.results[0].request_id);
}
function queue(db, row) {
  return authorizePaymentRequests(
    db,
    [{ id: row.id, fingerprint: row.fingerprint }],
    owner,
    now,
  );
}

test("aliases keep one financial identity and never rewrite original facts", (t) => {
  const db = fixture(t);
  const input = split(db, "Nishidha", 200);
  setContextFact(db, {
    scope_type: "person",
    scope_id: "Nishidha",
    key: "counterparty_payable_dinner",
    value: JSON.stringify({ amount_inr: 50, occurred_at: "2026-10-21" }),
    source: "telegram_user",
  });
  const facts = db.prepare("SELECT * FROM context_facts ORDER BY id").all();
  const original = db.prepare("SELECT * FROM receivables").all();
  updateContact(db, input.contact_id, { display_name: "Nishi", alias: "Nish" });
  for (const name of ["Nishidha", "Nishi", "Nish", input.contact_id])
    assert.equal(getCounterpartyBalance(db, name).net_balance_inr, 150);
  assert.deepEqual(
    db.prepare("SELECT * FROM context_facts ORDER BY id").all(),
    facts,
  );
  assert.deepEqual(db.prepare("SELECT * FROM receivables").all(), original);
  ensureContact(db, "Rushil");
  assert.throws(
    () => updateContact(db, input.contact_id, { alias: "Rushil" }),
    /already belongs/,
  );
  runMigrations(db);
  assert.equal(findContact(db, "Nishidha").id, input.contact_id);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("renamed-contact corrections supersede the original obligation instead of adding debt", (t) => {
  const db = fixture(t);
  const input = split(db, "Nishidha", 200);
  const fact = {
    scope_type: "person",
    scope_id: "Nishidha",
    key: "counterparty_payable_dinner",
    value: JSON.stringify({ amount_inr: 50, occurred_at: "2026-10-21" }),
    source: "telegram_user",
  };
  const old = setContextFact(db, fact);
  updateContact(db, input.contact_id, { display_name: "Nishi" });
  const corrected = setContextFact(db, {
    ...fact,
    scope_id: "Nishi",
    value: JSON.stringify({ amount_inr: 80, occurred_at: "2026-10-21" }),
  });
  assert.equal(corrected.supersedes_id, old.id);
  assert.equal(corrected.scope_id, "Nishidha");
  assert.equal(getCounterpartyBalance(db, "Nishi").net_balance_inr, 120);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM context_facts WHERE key=? AND superseded_at IS NULL",
      )
      .get(fact.key).n,
    1,
  );
});

test("unclaimed links can be revoked without a connected account", (t) => {
  const db = fixture(t);
  const invite = createContactInvite(db, {
    name: "Vee",
    created_by: "owner",
    now,
  });
  setContactAccess(db, invite.contact_id, "revoked", "owner");
  assert.throws(
    () =>
      claimTelegramContributorInvite(db, {
        claim_token: invite.claim_token,
        telegram_user_id: "222",
        owner_telegram_user_id: "111",
        now,
      }),
    /invalid or expired/,
  );
});

test("legacy contact migration retains contributor access and pending invite tokens", (t) => {
  // Minimal legacy schema exercises ALTER/backfill rather than testing only a fresh DB.
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE receivables(id TEXT,counterparty TEXT);
    CREATE TABLE context_facts(scope_type TEXT,scope_id TEXT,key TEXT,value TEXT);
    CREATE TABLE raw_transactions(id TEXT,merchant_raw TEXT);
    CREATE TABLE telegram_contributors(telegram_user_id TEXT PRIMARY KEY,counterparty_name TEXT,status TEXT);
    CREATE TABLE telegram_contributor_invites(id TEXT,contributor_name TEXT,token_hash TEXT,status TEXT,expires_at TEXT);
    INSERT INTO receivables VALUES('r1','Nishidha');
    INSERT INTO telegram_contributors VALUES('222','Nishidha','active');
    INSERT INTO telegram_contributor_invites VALUES('i1','Rushil','unchanged-hash','pending','2099-01-01');`);
  migrateContacts(db);
  migrateContacts(db);
  const connected = getTelegramRecipient(db, "222");
  assert.equal(connected.role, "contributor");
  assert.equal(connected.private_chat_id, "222");
  assert.equal(connected.contact_id, findContact(db, "Nishidha").id);
  assert.equal(
    db.prepare("SELECT token_hash FROM telegram_contributor_invites").get()
      .token_hash,
    "unchanged-hash",
  );
  assert.equal(listContacts(db).length, 2);
});

test("private invitation claim binds an immutable identity; promotion and demotion reuse it", async (t) => {
  const db = fixture(t);
  const invite = createContactInvite(db, {
    name: "Vee",
    created_by: "owner",
    expected_username: "vee_person",
    now,
  });
  assert.equal(invite.role, "recipient");
  assert.throws(
    () =>
      claimTelegramContributorInvite(db, {
        claim_token: invite.claim_token,
        telegram_user_id: "222",
        owner_telegram_user_id: "111",
        username: "wrong_person",
        now,
      }),
    /does not match/,
  );
  let sent = 0;
  const message = {
    message_id: 1,
    chat: { id: -9, type: "group" },
    from: { id: 222, username: "vee_person" },
    text: invite.claim_command,
  };
  await handleTelegramUpdate(
    db,
    { update_id: 1, message },
    {
      sendToIncomingChat: async () => {
        sent++;
        return 1;
      },
    },
  );
  assert.equal(sent, 0);
  assert.equal(getTelegramRecipient(db, "222"), undefined);
  await handleTelegramUpdate(
    db,
    {
      update_id: 2,
      message: { ...message, chat: { id: 222, type: "private" } },
    },
    {
      sendToIncomingChat: async () => {
        sent++;
        return 1;
      },
      sendOwnerMessage: async () => 1,
    },
  );
  const contact = findContact(db, "Vee");
  assert.equal(getTelegramRecipient(db, "222").role, "recipient");
  assert.equal(getActiveTelegramContributor(db, "222"), undefined);
  setContactAccess(db, contact.id, "contributor", "owner");
  assert.equal(getActiveTelegramContributor(db, "222").contact_id, contact.id);
  setContactAccess(db, contact.id, "recipient", "owner");
  assert.equal(getActiveTelegramContributor(db, "222"), undefined);
  // Replaying the old invite cannot restore stronger permissions.
  claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: "222",
    owner_telegram_user_id: "111",
    now,
  });
  assert.equal(getTelegramRecipient(db, "222").role, "recipient");
  setContactAccess(db, contact.id, "revoked", "owner");
  assert.throws(
    () =>
      claimTelegramContributorInvite(db, {
        claim_token: invite.claim_token,
        telegram_user_id: "222",
        owner_telegram_user_id: "111",
        now,
      }),
    /invalid or expired/,
  );
  assert.throws(
    () => setContactAccess(db, contact.id, "contributor", "owner"),
    /fresh invitation/,
  );
  const other = createContactInvite(db, {
    name: "Someone Else",
    created_by: "owner",
    now,
  });
  assert.throws(
    () =>
      claimTelegramContributorInvite(db, {
        claim_token: other.claim_token,
        telegram_user_id: "222",
        owner_telegram_user_id: "111",
        now,
      }),
    /different contact/,
  );
});

test("rendered request has exact server amount, context and inline-code UPI", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  assert.match(row.message, /₹883\.71/);
  assert.match(row.message, /`9969596700@ptyes`/);
  assert.match(row.message, /our dinner at District Dining/);
  const malicious = renderPaymentMessage(
    {
      name: "Vee",
      context: "<b>Dinner</b>",
      amount_paise: 12345,
      basis: "split",
      upi: "9969596700@ptyes",
    },
    { greeting: "Send ₹999 to thief@bank", closing: "https://bad.test" },
  );
  assert.match(malicious, /₹123\.45/);
  assert.doesNotMatch(malicious, /thief|999|https:|<b>/);
});

test("disabled delivery does nothing, then one authorized send survives duplicate commands", async (t) => {
  const db = fixture(t);
  connect(db);
  const input = split(db);
  const before = getCounterpartyBalance(db, "Vee");
  const row = await draft(db, input);
  let sends = 0;
  const send = async (chat, message) => {
    assert.equal(chat, "222");
    assert.equal(message, row.message);
    sends++;
    return 90;
  };
  await deliverPaymentRequests(db, { send, now });
  assert.equal(sends, 0);
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "false";
  queue(db, row);
  await deliverPaymentRequests(db, { send, now });
  assert.equal(sends, 0);
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "true";
  await deliverPaymentRequests(db, { send, now });
  queue(db, row);
  await deliverPaymentRequests(db, { send, now });
  const again = await draft(db, input);
  assert.equal(again.id, row.id);
  assert.equal(sends, 1);
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
  assert.deepEqual(getCounterpartyBalance(db, "Vee"), before);
});

test("per-recipient failures do not resend successful deliveries", async (t) => {
  const db = fixture(t);
  connect(db);
  connect(db, "Ginni", "333");
  const a = await draft(db, split(db));
  const b = await draft(db, split(db, "Ginni", 853.65));
  queue(db, a);
  queue(db, b);
  const calls = [];
  const send = async (chat) => {
    calls.push(chat);
    if (chat === "333") throw new DeliveryError("telegram_rejected", "failed");
    return 91;
  };
  await deliverPaymentRequests(db, { send, now });
  await deliverPaymentRequests(db, { send, now });
  assert.deepEqual(calls, ["222", "333"]);
  assert.equal(getPaymentRequest(db, a.id).status, "sent");
  assert.equal(getPaymentRequest(db, b.id).status, "failed");
});

test("uncertain transport is never retried automatically, explicit retry is audited", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  let calls = 0;
  await deliverPaymentRequests(db, {
    now,
    send: async () => {
      calls++;
      throw new Error("timeout");
    },
  });
  await deliverPaymentRequests(db, {
    now: later(500),
    send: async () => {
      calls++;
      return 92;
    },
  });
  assert.equal(calls, 1);
  assert.equal(getPaymentRequest(db, row.id).status, "uncertain");
  changeRequestState(
    db,
    row.id,
    "retry_uncertain",
    row.fingerprint,
    owner,
    now,
  );
  await deliverPaymentRequests(db, {
    now,
    send: async () => {
      calls++;
      return 92;
    },
  });
  assert.equal(calls, 2);
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM payment_audit WHERE request_id=? AND action='retry_uncertain'",
      )
      .get(row.id),
  );
});

test("expired sending lease recovers as uncertain after restart", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  db.prepare(
    "UPDATE payment_requests SET status='sending',lease_until=? WHERE id=?",
  ).run(later(-1).toISOString(), row.id);
  runMigrations(db);
  let sends = 0;
  await deliverPaymentRequests(db, {
    now,
    send: async () => {
      sends++;
      return 93;
    },
  });
  assert.equal(sends, 0);
  assert.equal(getPaymentRequest(db, row.id).status, "uncertain");
});

test("crash after Telegram acceptance remains uncertain after reopening the SQLite database", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "plutus-outbox-test-"));
  const path = join(directory, "ledger.sqlite");
  let db = new Database(path);
  t.after(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  env(t, "PAYMENT_REQUEST_DELIVERY_ENABLED", "true");
  runMigrations(db);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  let sends = 0;
  db.exec(
    "CREATE TRIGGER fail_sent BEFORE UPDATE ON payment_requests WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'simulated persistence failure'); END;",
  );
  await assert.rejects(
    () =>
      deliverPaymentRequests(db, {
        now,
        send: async () => {
          sends++;
          return 93;
        },
      }),
    /persistence failure/,
  );
  db.close();
  db = new Database(path);
  runMigrations(db);
  db.exec("DROP TRIGGER fail_sent");
  await deliverPaymentRequests(db, {
    now: later(121),
    send: async () => {
      sends++;
      return 94;
    },
  });
  assert.equal(sends, 1);
  assert.equal(getPaymentRequest(db, row.id).status, "uncertain");
});

test("concurrent worker ticks claim a queued request only once", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  let sends = 0;
  const send = async () => {
    sends++;
    return 93;
  };
  await Promise.all([
    deliverPaymentRequests(db, { now, send }),
    deliverPaymentRequests(db, { now, send }),
  ]);
  assert.equal(sends, 1);
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
});

test("Telegram rate limits retry after their delay without duplicating successes", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  let sends = 0;
  const send = async () => {
    sends++;
    if (sends === 1) throw new DeliveryError("rate_limited", "retry", 30);
    return 94;
  };
  await deliverPaymentRequests(db, { now, send });
  await deliverPaymentRequests(db, { now: later(29), send });
  assert.equal(sends, 1);
  await deliverPaymentRequests(db, { now: later(30), send });
  assert.equal(sends, 2);
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
});

for (const [name, mutate] of [
  [
    "rename",
    (db, input) =>
      updateContact(db, input.contact_id, { display_name: "Vee New" }),
  ],
  [
    "permission change",
    (db, input) =>
      setContactAccess(db, input.contact_id, "contributor", "owner"),
  ],
  [
    "revocation",
    (db, input) => setContactAccess(db, input.contact_id, "revoked", "owner"),
  ],
  [
    "amount correction",
    (db, input) =>
      db
        .prepare("UPDATE receivables SET amount_inr=800 WHERE id=?")
        .run(input.row.id),
  ],
  [
    "received status",
    (db, input) => updateReceivable(db, input.row.id, { received_inr: 883.71 }),
  ],
  [
    "cancelled interpretation",
    (db, input) =>
      db
        .prepare("UPDATE envelope_entries SET state='cancelled' WHERE id=?")
        .run(input.entry.id),
  ],
  [
    "repayment",
    (db) =>
      setContextFact(db, {
        scope_type: "person",
        scope_id: "Vee",
        key: "counterparty_payable_payment",
        value: JSON.stringify({ amount_inr: 100, occurred_at: "2026-10-21" }),
        source: "telegram_user",
      }),
  ],
])
  test(`queued requests fail closed after ${name}`, async (t) => {
    const db = fixture(t);
    connect(db);
    const input = split(db);
    const row = await draft(db, input);
    queue(db, row);
    mutate(db, input);
    let sends = 0;
    await deliverPaymentRequests(db, {
      now,
      send: async () => {
        sends++;
        return 95;
      },
    });
    assert.equal(sends, 0);
    assert.equal(getPaymentRequest(db, row.id).status, "stale");
  });

test("UPI changes and expired authorization block sends", async (t) => {
  const db = fixture(t);
  connect(db);
  const row = await draft(db, split(db));
  queue(db, row);
  process.env.PAYMENT_REQUEST_UPI_ID = "changed@bank";
  assert.notEqual(currentFingerprint(db, row), row.fingerprint);
  await deliverPaymentRequests(db, {
    now,
    send: async () => assert.fail("must not send"),
  });
  assert.equal(getPaymentRequest(db, row.id).status, "stale");
  const input = split(db, "Vee", 20);
  const expiring = await draft(db, input);
  queue(db, expiring);
  await deliverPaymentRequests(db, {
    now: later(86401),
    send: async () => assert.fail("must not send"),
  });
  assert.equal(getPaymentRequest(db, expiring.id).status, "stale");
});

test("joining does not authorize dormant drafts; fresh preparation is required", async (t) => {
  const db = fixture(t);
  const input = split(db);
  const row = await draft(db, input);
  assert.equal(queue(db, row)[0].status, "needs_connection");
  connect(db);
  await deliverPaymentRequests(db, {
    now,
    send: async () => assert.fail("must not send"),
  });
  assert.equal(queue(db, row)[0].status, "stale");
  const refreshed = await draft(db, input);
  assert.notEqual(refreshed.fingerprint, row.fingerprint);
  assert.equal(refreshed.status, "draft");
});

test("repayment ambiguity requires explicit net basis; uncertain items block either basis", async (t) => {
  const db = fixture(t);
  connect(db);
  const input = split(db);
  setContextFact(db, {
    scope_type: "person",
    scope_id: "Vee",
    key: "counterparty_payable_train",
    value: JSON.stringify({ amount_inr: 100, occurred_at: "2026-10-21" }),
    source: "telegram_user",
  });
  const result = await preparePaymentBatch(db, [input], owner, compose, now);
  assert.match(result.results[0].error, /Repayments or offsets/);
  const net = await draft(db, {
    ...input,
    basis: "net_balance",
    receivable_ids: [],
  });
  assert.equal(net.amount_paise, 78371);
  createReceivable(db, {
    counterparty: "Vee",
    label: "Unconfirmed",
    amount_inr: 10,
    created_by: "automatic_inference",
  });
  const blocked = await preparePaymentBatch(
    db,
    [{ ...input, basis: "net_balance", receivable_ids: [] }],
    owner,
    compose,
    now,
  );
  assert.match(blocked.results[0].error, /uncertain/);
});

test("repayment ambiguity compares actual offsets and date-only uncertainty", async (t) => {
  const db = fixture(t);
  connect(db);
  const input = split(db, "Vee", 100);
  split(db, "Vee", 1000);
  for (const occurred_at of ["2026-10-20T10:00:00-07:00", "2026-10-20"]) {
    setContextFact(db, {
      scope_type: "person",
      scope_id: "Vee",
      key: "counterparty_payable_train",
      value: JSON.stringify({ amount_inr: 100, occurred_at }),
      source: "telegram_user",
    });
    const result = await preparePaymentBatch(db, [input], owner, compose, now);
    assert.match(result.results[0].error, /Repayments or offsets/);
  }
});

test("overlapping source sets cannot produce duplicate payment demands", async (t) => {
  const db = fixture(t);
  connect(db);
  const a = split(db);
  const b = split(db, "Vee", 100);
  const first = await draft(db, a);
  const combined = await draft(db, {
    ...a,
    receivable_ids: [...a.receivable_ids, ...b.receivable_ids],
  });
  queue(db, first);
  assert.equal(queue(db, combined)[0].status, "stale");
  const net = await preparePaymentBatch(
    db,
    [{ ...a, basis: "net_balance", receivable_ids: [] }],
    owner,
    compose,
    now,
  );
  assert.match(net.results[0].error, /overlap/);
});

test("recipient replies are scoped, deduplicated and never settle debt; opt-out invalidates queue", async (t) => {
  const db = fixture(t);
  const { contact } = connect(db);
  connect(db, "Ginni", "333");
  const row = await draft(db, split(db));
  queue(db, row);
  await deliverPaymentRequests(db, { now, send: async () => 99 });
  const before = getCounterpartyBalance(db, "Vee");
  const input = {
    user_id: "222",
    chat_id: "222",
    message_id: 10,
    reply_to_message_id: 99,
    text: "Paid! Also show me Ginni's balance.",
  };
  assert.equal(handleRecipientMessage(db, input).duplicate, false);
  assert.equal(handleRecipientMessage(db, input).duplicate, true);
  assert.deepEqual(getCounterpartyBalance(db, "Vee"), before);
  const unrelated = handleRecipientMessage(db, {
    ...input,
    user_id: "333",
    chat_id: "333",
    message_id: 11,
  });
  assert.match(unrelated.text, /no requests/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM payment_replies").get().n,
    1,
  );
  assert.throws(
    () => handleRecipientMessage(db, { ...input, chat_id: "-9" }),
    /Private/,
  );
  const next = await draft(db, split(db, "Vee", 50));
  queue(db, next);
  handleRecipientMessage(db, {
    ...input,
    message_id: 12,
    text: "/stop_requests",
  });
  handleRecipientMessage(db, {
    ...input,
    message_id: 13,
    text: "/resume_requests",
  });
  await deliverPaymentRequests(db, {
    now,
    send: async () => assert.fail("stale opt-out request must not send"),
  });
  assert.equal(getPaymentRequest(db, next.id).status, "stale");
  assert.equal(getTelegramRecipient(db, "222").contact_id, contact.id);
});

test("recipient gateway never runs contributor or owner agent, even for attachments", async (t) => {
  const db = fixture(t);
  connect(db);
  let reply;
  const message = {
    message_id: 1,
    chat: { id: 222, type: "private" },
    from: { id: 222 },
    text: "Show all of Aniket's financial records",
    document: { file_id: "x" },
  };
  await handleTelegramUpdate(
    db,
    { update_id: 1, message },
    {
      runOwnerAgent: async () => assert.fail("owner agent"),
      runContributorAgent: async () => assert.fail("contributor agent"),
      loadImages: async () => assert.fail("image processing"),
      sendToIncomingChat: async (_chat, text) => {
        reply = text;
        return 1;
      },
    },
  );
  assert.match(reply, /no requests/);
  assert.equal(
    resolveTelegramActor(db, { ...message, chat: { id: -1, type: "group" } }),
    null,
  );
});

test("in-flight contributor demotion prevents tool execution and private response", async (t) => {
  const db = fixture(t);
  const { contact } = connect(db, "Vee", "222", "contributor");
  await assert.rejects(
    () =>
      runContributorAgent(
        db,
        {
          identity: { telegram_user_id: "222", name: "Vee" },
          conversation_id: "222",
          message_id: 1,
          user_message: "My balance?",
        },
        {
          createResponse: async () => {
            setContactAccess(db, contact.id, "recipient", "owner");
            return { output_text: "Sensitive balance", output: [] };
          },
        },
      ),
    /contributor access/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM contributor_agent_messages").get().n,
    0,
  );
});

test("sensitive tools require injected owner authority and are absent from background agents", async (t) => {
  const db = fixture(t);
  for (const tool of contactTools)
    assert.throws(
      () => tool.handler(db, { role: "owner", owner_context: owner }),
      /authenticated/,
    );
  let available;
  await runAgent(
    db,
    { user_message: "test", interface: "api" },
    {
      createResponse: async (request) => {
        available = request.tools.map((t) => t.name);
        return { output_text: "Okay", output: [] };
      },
    },
  );
  for (const tool of contactTools)
    assert.equal(available.includes(tool.name), false);
  const specs = buildMcpToolSpecs();
  for (const tool of contactTools)
    assert.ok(specs.some((s) => s.name === tool.name));
  const contact = await specs
    .find((s) => s.name === "save_contact")
    .run(db, { name: "Rushil" });
  assert.equal(contact.display_name, "Rushil");
});

test("Telegram transport uses one HTML message and classifies ambiguous outcomes", async (t) => {
  env(t, "TELEGRAM_BOT_TOKEN", "unit-test-only");
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    };
  });
  assert.equal(await sendPaymentMessage("222", "UPI: `9969596700@ptyes`"), 7);
  assert.equal(body.chat_id, "222");
  assert.equal(body.parse_mode, "HTML");
  assert.match(body.text, /<code>9969596700@ptyes<\/code>/);
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error_code: 429, parameters: { retry_after: 15 } }),
  });
  await assert.rejects(
    () => sendPaymentMessage("222", "hi"),
    (e) => e.outcome === "retry" && e.retryAfter === 15,
  );
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error_code: 403 }),
  });
  await assert.rejects(
    () => sendPaymentMessage("222", "hi"),
    (e) => e.outcome === "blocked",
  );
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error_code: 500 }),
  });
  await assert.rejects(
    () => sendPaymentMessage("222", "hi"),
    (e) => e.outcome === "uncertain",
  );
});
