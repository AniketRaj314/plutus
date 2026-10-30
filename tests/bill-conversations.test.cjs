require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../src/db/schema");
const { insertAgentMessage } = require("../src/db/queries");
const {
  createEnvelopeEntry,
  createReceivable,
  updateReceivable,
  getCounterpartyBalance,
} = require("../src/db/v2-queries");
const {
  createContactInvite,
  claimTelegramContributorInvite,
  setContactAccess,
} = require("../src/telegram/access");
const {
  preparePaymentBatch,
  authorizePaymentRequests,
  getPaymentRequest,
} = require("../src/payments/requests");
const {
  deliverPaymentRequests,
  DeliveryError,
} = require("../src/payments/delivery");
const {
  handleRecipientMessage,
  processRecipientConversations,
} = require("../src/payments/replies");
const { recipientPacket } = require("../src/payments/recipient-agent");
const {
  getBillContext,
  saveBillExplanation,
  linkOwnerMessages,
  billIds,
} = require("../src/payments/bill-context");
const {
  deliverChatMessages,
  relayOwnerReply,
  ownerReplyRequest,
} = require("../src/payments/chat-delivery");
const { handleTelegramUpdate } = require("../src/telegram/bot");
const { runAgent } = require("../src/agent/runner");
const { contactTools } = require("../src/agent/contact-tools");
const owner = () => ({
  role: "owner",
  actor: "test-owner",
  source: "telegram",
  request_id: "turn-1",
});

function fixture(t) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const env = {
    PAYMENT_REQUEST_DELIVERY_ENABLED: "true",
    TELEGRAM_OWNER_USER_ID: "111",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
    TELEGRAM_CHAT_ID: "-100",
    TELEGRAM_THREAD_ID: "7",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    db.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return db;
}
function connect(db, name = "Vee", user = "222", role = "recipient") {
  const invite = createContactInvite(db, { name, role, created_by: "owner" });
  return claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: user,
    owner_telegram_user_id: "111",
  }).contributor;
}
async function request(
  db,
  person,
  label = "District lunch",
  amount = 100,
  messageId = 99,
) {
  const entry = createEnvelopeEntry(db, {
    funding_month: "2026-10",
    treatment: "split",
    gross_amount_inr: amount * 2,
    personal_impact: amount,
    cashflow_impact: amount * 2,
    receivable_amount: amount,
    state: "actual",
    merchant_clean: label,
    created_by: "telegram_user",
  });
  const receivable = createReceivable(db, {
    envelope_entry_id: entry.id,
    counterparty: person.counterparty_name,
    label,
    amount_inr: amount,
    created_by: "telegram_user",
  });
  const draft = await preparePaymentBatch(
    db,
    [
      {
        contact_id: person.contact_id,
        receivable_ids: [receivable.id],
        context: label,
      },
    ],
    owner(),
    async (f) => `Your share: ${f.amount_paise / 100}`,
  );
  assert.equal(draft.results[0].error, undefined);
  const row = getPaymentRequest(db, draft.results[0].request_id);
  authorizePaymentRequests(
    db,
    [{ id: row.id, fingerprint: row.fingerprint }],
    owner(),
  );
  await deliverPaymentRequests(db, { send: async () => messageId });
  return { ...getPaymentRequest(db, row.id), entry, receivable };
}
const incoming = (text, message_id = 1, extra = {}) => ({
  user_id: "222",
  chat_id: "222",
  message_id,
  text,
  ...extra,
});
function sender() {
  const sent = [];
  return {
    sent,
    send: async (chat, text, options) => {
      sent.push({ chat, text, options });
      return 1000 + sent.length;
    },
  };
}

test("bill projection excludes private owner history, tentative notes and other contacts", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const other = connect(db, "Ginni", "333");
  const row = await request(db, person);
  const message = insertAgentMessage(db, {
    role: "user",
    content: "Shared fee is 20. PRIVATE: my salary is 123456.",
    interface: "telegram",
  });
  linkOwnerMessages(db, billIds(db, row.id), [message.id]);
  const privateContext = getBillContext(db, row.id, owner());
  assert.match(JSON.stringify(privateContext), /salary/);
  const save = (contact, explanation, state = "confirmed") =>
    saveBillExplanation(
      db,
      {
        reference_id: row.id,
        contact_id: contact,
        explanation,
        state,
        source_message_ids: [message.id],
      },
      owner(),
    );
  save(person.contact_id, "Your item is 80 plus 20 shared fees.");
  save(other.contact_id, "SECRET_OTHER_PERSON");
  const packet = recipientPacket(db, row, "Why 100?", 999);
  assert.match(JSON.stringify(packet), /80 plus 20/);
  assert.doesNotMatch(
    JSON.stringify(packet),
    /salary|123456|SECRET_OTHER_PERSON|ledger|owner_only_history/,
  );
  save(person.contact_id, "PRIVATE_DRAFT", "tentative");
  assert.doesNotMatch(
    JSON.stringify(recipientPacket(db, row, "why?", 999)),
    /PRIVATE_DRAFT/,
  );
  assert.throws(
    () =>
      saveBillExplanation(
        db,
        {
          reference_id: row.id,
          contact_id: person.contact_id,
          explanation: "x",
          state: "confirmed",
          source_message_ids: [message.id + 20],
        },
        owner(),
      ),
    /source must belong/,
  );
});

test("unthreaded follow-ups remember this bill, explanations do not notify and duplicates do not send", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  const transport = sender();
  const before = getCounterpartyBalance(db, person.contact_id);
  handleRecipientMessage(
    db,
    incoming("How was this calculated?", 1, { reply_to_message_id: 99 }),
  );
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({
      text: "Your item was 80 and fees were 20.",
      intent: "none",
    }),
  });
  handleRecipientMessage(db, incoming("Thanks, that makes sense", 2));
  let packet;
  await processRecipientConversations(db, {
    ...transport,
    answer: async (p) => {
      packet = p;
      return { text: "You're welcome!", intent: "none" };
    },
  });
  assert.equal(packet.messages.length, 1);
  assert.match(packet.messages[0].response, /80/);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM payment_chat_events WHERE request_id=?")
      .get(row.id).n,
    2,
  );
  assert.equal(
    handleRecipientMessage(db, incoming("Thanks, that makes sense", 2))
      .duplicate,
    true,
  );
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => assert.fail("duplicate AI"),
  });
  assert.equal(transport.sent.length, 2);
  assert.ok(transport.sent.every((r) => r.chat === "222"));
  assert.deepEqual(getCounterpartyBalance(db, person.contact_id), before);
});

test("ambiguous bills ask once, retain the question and resolve a stable choice", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  await request(db, person, "Lunch", 100, 99);
  await request(db, person, "Dinner", 200, 100);
  const selection = handleRecipientMessage(
    db,
    incoming("Why was the discount missing?"),
  );
  assert.match(selection.text, /Which split/);
  assert.doesNotMatch(selection.text, /Your share/);
  const ids = JSON.parse(
    db.prepare("SELECT selection_ids FROM payment_chat_sessions").get()
      .selection_ids,
  );
  await request(db, person, "New bill", 300, 101);
  const result = handleRecipientMessage(db, incoming("1", 2));
  const event = db
    .prepare("SELECT * FROM payment_chat_events WHERE id=?")
    .get(result.event_id);
  assert.equal(event.request_id, ids[0]);
  assert.equal(event.text, "Why was the discount missing?");
});

test("disputes notify owner in the configured topic and owner-authorized replies close the loop", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  const transport = sender();
  const before = getCounterpartyBalance(db, person.contact_id);
  handleRecipientMessage(db, incoming("I didn't eat at all"));
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({
      text: "That sounds like something we should clear up.",
      intent: "dispute",
    }),
  });
  assert.equal(transport.sent[0].chat, "-100");
  assert.equal(transport.sent[0].options.thread_id, 7);
  assert.match(transport.sent[0].text, /didn't eat/);
  assert.match(transport.sent[1].text, /I've notified Aniket/);
  assert.equal(ownerReplyRequest(db, "-100", 7, 1001), row.id);
  assert.equal(ownerReplyRequest(db, "-999", 7, 1001), undefined);
  assert.equal(ownerReplyRequest(db, "-100", 8, 1001), undefined);
  const reply = await relayOwnerReply(
    db,
    row.id,
    "Thanks, I'll review the items with you.",
    owner(),
    transport.send,
  );
  assert.equal(reply.status, "sent");
  assert.equal(transport.sent[2].chat, "222");
  assert.match(transport.sent[2].text, /Aniket replied/);
  await relayOwnerReply(
    db,
    row.id,
    "Thanks, I'll review the items with you.",
    owner(),
    transport.send,
  );
  await assert.rejects(
    relayOwnerReply(
      db,
      row.id,
      "A different response",
      owner(),
      transport.send,
    ),
    /different reply/,
  );
  assert.equal(transport.sent.length, 3);
  assert.equal(
    db.prepare("SELECT review_status FROM payment_chat_events").get()
      .review_status,
    "pending_owner",
  );
  assert.deepEqual(getCounterpartyBalance(db, person.contact_id), before);
});

test("failed/uncertain owner notifications are visible and never acknowledged as delivered or blindly retried", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  await request(db, person);
  let ownerSends = 0;
  const responses = [];
  handleRecipientMessage(db, incoming("Tell Aniket I didn't like the food"));
  const send = async (chat, text) => {
    if (chat === "-100") {
      ownerSends++;
      throw new DeliveryError("network_unknown", "uncertain");
    }
    responses.push(text);
    return 1;
  };
  await processRecipientConversations(db, {
    send,
    answer: async () => ({ text: "Got it.", intent: "relay" }),
  });
  assert.match(responses[0], /couldn't confirm/);
  assert.doesNotMatch(responses[0], /I've notified/);
  await deliverChatMessages(db, { send });
  assert.equal(ownerSends, 1);
  assert.equal(
    db
      .prepare(
        "SELECT status FROM payment_chat_outbox WHERE kind='owner_alert'",
      )
      .get().status,
    "uncertain",
  );
});

test("payment claims and AI failures notify but never settle debt", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  await request(db, person);
  const transport = sender();
  const before = getCounterpartyBalance(db, person.contact_id);
  handleRecipientMessage(db, incoming("Paid just now"));
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({
      text: "Thanks for letting me know!",
      intent: "payment_claim",
    }),
  });
  assert.match(transport.sent[1].text, /unverified/);
  handleRecipientMessage(db, incoming("And I didn't eat the starter", 2));
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => {
      throw new Error("model unavailable");
    },
  });
  assert.equal(transport.sent.filter((r) => r.chat === "-100").length, 2);
  assert.deepEqual(getCounterpartyBalance(db, person.contact_id), before);
});

test("financial changes invalidate explanations and override stale model answers", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  const transport = sender();
  saveBillExplanation(
    db,
    {
      reference_id: row.id,
      contact_id: person.contact_id,
      explanation: "OLD_CALCULATION",
      state: "confirmed",
      source_message_ids: [],
    },
    owner(),
  );
  updateReceivable(db, row.receivable.id, {
    received_inr: 10,
    status: "partial",
  });
  assert.doesNotMatch(
    JSON.stringify(recipientPacket(db, row, "why?", 999)),
    /OLD_CALCULATION/,
  );
  handleRecipientMessage(db, incoming("How much do I owe?"));
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({ text: "You still owe 100.", intent: "none" }),
  });
  assert.doesNotMatch(transport.sent[1].text, /still owe 100/);
  assert.match(transport.sent[1].text, /changed/);
});

test("in-flight revocation and role changes prevent recipient response disclosure", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  await request(db, person);
  handleRecipientMessage(db, incoming("Why this amount?"));
  await processRecipientConversations(db, {
    send: async () => assert.fail("must not send"),
    answer: async () => {
      setContactAccess(db, person.contact_id, "contributor", "owner");
      return { text: "Private answer", intent: "none" };
    },
  });
  assert.equal(
    db.prepare("SELECT status FROM payment_chat_events").get().status,
    "cancelled",
  );
});

test("concurrent workers serialize a contact's turns and preserve ordering", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  await request(db, person);
  const transport = sender();
  handleRecipientMessage(db, incoming("First question", 1));
  handleRecipientMessage(db, incoming("Second question", 2));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const options = {
    ...transport,
    answer: async (p) => {
      calls++;
      if (calls === 1) await gate;
      return { text: p.recipient_message, intent: "none" };
    },
  };
  const first = processRecipientConversations(db, options);
  await processRecipientConversations(db, options);
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 2);
  assert.equal(transport.sent.length, 2);
});

test("restart recovery does not replay old replies or ambiguous sends; disabled delivery makes no calls", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  db.prepare(
    "INSERT INTO payment_replies(request_id,telegram_user_id,message_id,text,created_at) VALUES (?,?,?,?,?)",
  ).run(row.id, "222", 30, "old comment", new Date().toISOString());
  runMigrations(db);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM payment_chat_events").get().n,
    0,
  );
  handleRecipientMessage(db, incoming("Please tell Aniket"));
  db.prepare(
    "UPDATE payment_chat_events SET status='processing',lease_until='2000-01-01'",
  ).run();
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "false";
  await processRecipientConversations(db, {
    answer: async () => assert.fail("disabled AI"),
  });
  assert.equal(
    db.prepare("SELECT status FROM payment_chat_events").get().status,
    "pending",
  );
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "true";
  const transport = sender();
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({ text: "Sure.", intent: "relay" }),
  });
  db.prepare(
    "UPDATE payment_chat_outbox SET status='sending',lease_until='2000-01-01' WHERE kind='owner_alert'",
  ).run();
  await deliverChatMessages(db, { send: async () => assert.fail("no retry") });
  assert.equal(
    db
      .prepare(
        "SELECT status FROM payment_chat_outbox WHERE kind='owner_alert'",
      )
      .get().status,
    "uncertain",
  );
});

test("plain start is welcoming without granting access or leaking records", async (t) => {
  const db = fixture(t);
  let reply;
  await handleTelegramUpdate(
    db,
    {
      update_id: 9,
      message: {
        message_id: 1,
        text: "/start",
        chat: { id: 444, type: "private" },
        from: { id: 444 },
      },
    },
    {
      sendToIncomingChat: async (_chat, text) => {
        reply = text;
        return 1;
      },
      runOwnerAgent: async () => assert.fail("owner agent"),
      runContributorAgent: async () => assert.fail("contributor agent"),
    },
  );
  assert.match(reply, /invitation link/);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM telegram_contributors").get().n,
    0,
  );
});

test("owner notification replies route bill context privately and do not automatically relay", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  const transport = sender();
  handleRecipientMessage(db, incoming("I didn't eat"));
  await processRecipientConversations(db, {
    ...transport,
    answer: async () => ({ text: "Let's clarify.", intent: "dispute" }),
  });
  let payload;
  await handleTelegramUpdate(
    db,
    {
      update_id: 10,
      message: {
        message_id: 5,
        text: "Let's review the items",
        chat: { id: -100, type: "supergroup" },
        message_thread_id: 7,
        from: { id: 111 },
        reply_to_message: { message_id: 1001 },
      },
    },
    {
      runOwnerAgent: async (_db, p) => {
        payload = p;
        return "Let's review.";
      },
      sendToIncomingChat: async () => 1,
      sendTyping: async () => {},
    },
  );
  assert.equal(payload.replied_to_payment_request_id, row.id);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM payment_chat_outbox WHERE kind='owner_relay'",
      )
      .get().n,
    0,
  );
});

test("owner discussion is linked through the runner and available to subsequent bill turns", async (t) => {
  const db = fixture(t);
  const person = connect(db);
  const row = await request(db, person);
  const context = owner();
  await runAgent(
    db,
    {
      owner_context: context,
      user_message: "The discount was shared proportionally",
      interface: "telegram",
      replied_to_payment_request_id: row.id,
    },
    {
      createResponse: async () => ({
        output: [],
        output_text: "Understood, the discount applies proportionally.",
      }),
    },
  );
  const history = getBillContext(db, row.id, owner())[0].owner_only_history;
  assert.equal(history.length, 2);
  assert.match(history[0].content, /discount was shared/);
  assert.match(history[1].content, /applies proportionally/);
  assert.throws(
    () =>
      contactTools
        .find((t) => t.name === "reply_to_split_recipient")
        .handler(db, {}, undefined),
    /authenticated/,
  );
});
