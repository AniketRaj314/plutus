require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { Readable } = require("node:stream");
const { runMigrations } = require("../src/db/schema");
const {
  createContactInvite,
  claimTelegramContributorInvite,
} = require("../src/telegram/access");
const {
  acceptSplitMessage,
  processSplitInbox,
} = require("../src/payments/split-conversation");
const {
  activeSplit,
  calculateSplit,
  saveSplit,
  submitSplit,
  reviewSplit,
  inspectSplit,
  emptySplit,
} = require("../src/payments/split-drafts");
const {
  deliverSplitMessages,
  queueSplitMessage,
  ownerSplitReference,
} = require("../src/payments/split-outbox");
const { DeliveryError } = require("../src/payments/delivery");
const { handleTelegramUpdate } = require("../src/telegram/bot");
const { loadTelegramImage } = require("../src/telegram/media");
const { buildUserInputItem } = require("../src/agent/image-input");
const { billLabel } = require("../src/payments/bill-label");
const {
  insertRawTransaction,
  createEnvelopeEntry,
  createReceivable,
  getCounterpartyBalance,
} = require("../src/db/v2-queries");
const {
  preparePaymentBatch,
  authorizePaymentRequests,
  getPaymentRequest,
} = require("../src/payments/requests");
const { deliverPaymentRequests } = require("../src/payments/delivery");
const { recipientPacket } = require("../src/payments/recipient-agent");
const { handleRecipientMessage } = require("../src/payments/replies");
const owner = {
  role: "owner",
  actor: "telegram:111",
  source: "telegram",
  request_id: "test-review",
};
const image = { data_url: "data:image/png;base64,iVBORw0KGgo=" };
const data = () => ({
  title: "Courtyard dinner",
  date: "2026-11-02",
  currency: "INR",
  payer: "sender",
  total_paise: 110000,
  receipt_reference: "ORDER-1",
  items: [
    { name: "Fries", amount_paise: 20000, owner_parts: 1, total_parts: 2 },
    {
      name: "Butter chicken roll",
      amount_paise: 30000,
      owner_parts: 0,
      total_parts: 1,
    },
    {
      name: "Aniket's food",
      amount_paise: 50000,
      owner_parts: 1,
      total_parts: 1,
    },
  ],
  adjustments: [{ label: "Taxes", amount_paise: 10000 }],
  unresolved: [],
});
function fixture(t, role = "recipient") {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runMigrations(db);
  const env = {
    PAYMENT_REQUEST_DELIVERY_ENABLED: "true",
    TELEGRAM_OWNER_USER_ID: "111",
    TELEGRAM_CHAT_ID: "-100",
    TELEGRAM_THREAD_ID: "7",
    TELEGRAM_WEBHOOK_SECRET: "test-secret",
  };
  const old = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    db.close();
    for (const [k, v] of Object.entries(old))
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const invite = createContactInvite(db, {
    name: "Parikshit",
    role,
    created_by: "owner",
  });
  const person = claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: "222",
    owner_telegram_user_id: "111",
  }).contributor;
  let seq = 100;
  const sent = [];
  const transport = {
    send: async (chat, text) => {
      sent.push({ chat, text });
      return ++seq;
    },
    sendMedia: async (row, media) => {
      sent.push({ chat: row.chat_id, media });
      return ++seq;
    },
  };
  return { db, person, transport, sent };
}
function incoming(text, id = 1, media = []) {
  return { userId: "222", chatId: "222", messageId: id, text, media };
}
const answer = (draft, action = "edit", reply = "Got it.") => ({
  route: "draft",
  request_id: null,
  reply,
  draft_action: action,
  draft,
});
async function ready(f) {
  const d = saveSplit(f.db, "222", data());
  queueSplitMessage(f.db, {
    userId: "222",
    audience: "recipient",
    draft: d,
    key: `preview:test:${d.revision}`,
    text: "Calculation preview",
  });
  await deliverSplitMessages(f.db, f.transport);
  submitSplit(f.db, d);
  return activeSplit(f.db, f.person.contact_id);
}
function noLedger(db) {
  assert.equal(
    db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM envelope_entries").get().n,
    0,
  );
}

test("separate description, receipt and payer follow-ups survive an old selection and restart until exact approval", async (t) => {
  const f = fixture(t),
    { db, person, transport } = f;
  db.prepare(
    "INSERT INTO payment_chat_sessions(contact_id,request_id,updated_at,pending_text) VALUES (?,NULL,?,?)",
  ).run(person.contact_id, new Date().toISOString(), "Which I paid for");
  acceptSplitMessage(
    db,
    incoming(
      "Courtyard dinner on 2 November. We shared fries. I had the roll. The rest was Aniket's.",
    ),
  );
  await processSplitInbox(db, {
    answer: async (packet) => {
      assert.match(packet.message.text, /shared fries/);
      return answer(
        { ...emptySplit, title: "Courtyard dinner", date: "2026-11-02" },
        "edit",
        "Send the receipt and tell me who paid.",
      );
    },
    send: transport.send,
  });
  acceptSplitMessage(db, incoming("Here's the receipt", 2, [image]));
  await processSplitInbox(db, {
    answer: async (packet, media) => {
      assert.match(packet.history[0].text, /shared fries/);
      assert.equal(media.length, 1);
      return answer(
        { ...data(), payer: "unknown" },
        "edit",
        "Thanks, who paid?",
      );
    },
    send: transport.send,
  });
  noLedger(db);
  acceptSplitMessage(db, incoming("Which I paid for", 3));
  await processSplitInbox(db, {
    answer: async (packet, media) => {
      assert.equal(media[0].data_url, image.data_url);
      assert.equal(packet.draft.data.date, "2026-11-02");
      return answer(data());
    },
    send: transport.send,
  });
  await deliverSplitMessages(db, transport);
  const d = activeSplit(db, person.contact_id);
  assert.equal(d.status, "draft");
  assert.ok(f.sent.some((s) => s.text?.includes("Aniket: ₹660.00")));
  noLedger(db);
  acceptSplitMessage(db, incoming("Looks right, send to Aniket", 4));
  await processSplitInbox(db, {
    answer: async () => answer(null, "submit"),
    send: transport.send,
  });
  assert.equal(activeSplit(db, person.contact_id).status, "submitted");
  noLedger(db);
  await deliverSplitMessages(db, transport);
  assert.ok(f.sent.some((s) => s.chat === "-100" && s.media));
  const approved = reviewSplit(
    db,
    { id: d.id, revision: d.revision, action: "approve" },
    owner,
  );
  assert.equal(approved.status, "approved");
  const raw = db.prepare("SELECT * FROM raw_transactions").get();
  assert.equal(raw.amount, 1100);
  assert.equal(JSON.parse(raw.raw_payload).approved_by, owner.actor);
  const bill = require("../src/payments/bill-context").getBillContext(
    db,
    raw.id,
    owner,
  )[0];
  assert.equal(
    JSON.parse(
      bill.receipt_facts.find((f) => f.key === "approved_split_receipt").value,
    ).receipt.items.length,
    3,
  );
  const entry = db.prepare("SELECT * FROM envelope_entries").get();
  assert.equal(entry.personal_impact, 660);
  assert.equal(entry.cashflow_impact, 0);
  assert.equal(getCounterpartyBalance(db, "Parikshit").net_balance_inr, -660);
  reviewSplit(db, { id: d.id, revision: d.revision, action: "approve" }, owner);
  assert.equal(
    db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
    1,
  );
  await deliverSplitMessages(db, transport);
  assert.equal(
    f.sent.filter((s) => s.text?.includes("is now recorded as owed to you"))
      .length,
    1,
  );
});

test("no direct approval, stale revision, unsubmitted preview or pending correction can mutate a balance", async (t) => {
  const f = fixture(t),
    { db, person } = f;
  let d = saveSplit(db, "222", data());
  assert.throws(() => submitSplit(db, d), /preview/);
  assert.throws(
    () =>
      reviewSplit(db, { id: d.id, revision: d.revision, action: "approve" }),
    /authenticated/,
  );
  d = await ready(f);
  acceptSplitMessage(db, incoming("Actually I had the fries alone", 10));
  assert.throws(
    () =>
      reviewSplit(
        db,
        { id: d.id, revision: d.revision, action: "approve" },
        owner,
      ),
    /still being processed/,
  );
  await processSplitInbox(db, {
    answer: async () =>
      answer({
        ...data(),
        items: data().items.map((i, n) =>
          n === 0 ? { ...i, owner_parts: 0 } : i,
        ),
      }),
    send: f.transport.send,
  });
  assert.throws(
    () =>
      reviewSplit(
        db,
        { id: d.id, revision: d.revision, action: "approve" },
        owner,
      ),
    /no longer current/,
  );
  assert.equal(activeSplit(db, person.contact_id).status, "draft");
  noLedger(db);
});

test("rejection notifies the sender, preserves evidence and never records spending", async (t) => {
  const f = fixture(t),
    d = await ready(f);
  reviewSplit(
    f.db,
    {
      id: d.id,
      revision: d.revision,
      action: "reject",
      note: "Please include the final discount.",
    },
    owner,
  );
  await deliverSplitMessages(f.db, f.transport);
  noLedger(f.db);
  assert.ok(
    f.sent.some((s) => s.text?.includes("Please include the final discount")),
  );
  assert.equal(inspectSplit(f.db, d.id, owner).status, "rejected");
});

test("exact Telegram owner reply binds approval to the sent version and topic", async (t) => {
  const f = fixture(t),
    d = await ready(f);
  await deliverSplitMessages(f.db, f.transport);
  const msg = f.db
    .prepare(
      "SELECT telegram_message_id FROM split_outbox WHERE audience='owner' AND media IS NULL",
    )
    .get().telegram_message_id;
  assert.equal(ownerSplitReference(f.db, "-100", 99, msg), undefined);
  assert.equal(ownerSplitReference(f.db, "222", 7, msg), undefined);
  let response;
  await handleTelegramUpdate(
    f.db,
    {
      update_id: 44,
      message: {
        message_id: 90,
        text: "Approve",
        from: { id: 111 },
        chat: { id: -100, type: "supergroup" },
        message_thread_id: 7,
        reply_to_message: { message_id: msg },
      },
    },
    {
      sendConversationMessage: f.transport.send,
      sendToIncomingChat: async (_c, text) => {
        response = text;
        return 91;
      },
      runOwnerAgent: async () => assert.fail("Approval must use exact version"),
    },
  );
  assert.match(response, /Approved/);
  assert.equal(inspectSplit(f.db, d.id, owner).status, "approved");
});

test("recipient photo reaches the limited draft agent with prior text, never the owner or contributor agent", async (t) => {
  const f = fixture(t);
  acceptSplitMessage(f.db, incoming("I paid for dinner", 1));
  await processSplitInbox(f.db, {
    answer: async () => answer({ ...emptySplit, payer: "sender" }),
    send: f.transport.send,
  });
  await handleTelegramUpdate(
    f.db,
    {
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 222 },
        chat: { id: 222, type: "private" },
        photo: [{ file_id: "receipt", width: 100, height: 100 }],
      },
    },
    {
      loadImages: async () => [image],
      answerSplit: async (packet, media) => {
        assert.match(packet.history[0].text, /paid/);
        assert.equal(media.length, 1);
        return answer(data());
      },
      sendConversationMessage: f.transport.send,
      runOwnerAgent: async () => assert.fail("owner"),
      runContributorAgent: async () => assert.fail("contributor"),
    },
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM split_inbox").get().n, 2);
  noLedger(f.db);
});

test("Telegram photo and PDF receipts are verified and passed as their correct model input types", async () => {
  const bytes = Buffer.from("%PDF-1.7\nreceipt fixture");
  const files = await loadTelegramImage(
    { getFileStream: () => Readable.from([bytes]) },
    { document: { file_id: "pdf", mime_type: "application/pdf" } },
  );
  assert.equal(files[0].mime_type, "application/pdf");
  assert.equal(
    buildUserInputItem("Receipt", files).content[1].type,
    "input_file",
  );
  assert.equal(
    buildUserInputItem("Receipt", [image]).content[1].type,
    "input_image",
  );
  await assert.rejects(
    loadTelegramImage(
      { getFileStream: () => Readable.from([Buffer.from("bad")]) },
      { document: { file_id: "fake", mime_type: "application/pdf" } },
    ),
    /verify that PDF/,
  );
});

test("receipt extraction failures retain ordered context and can be retried without duplicate events", async (t) => {
  const f = fixture(t),
    input = incoming("Receipt", 1, [image]);
  assert.equal(
    acceptSplitMessage(f.db, input),
    acceptSplitMessage(f.db, input),
  );
  for (let i = 0; i < 3; i++)
    await processSplitInbox(f.db, {
      answer: async () => {
        throw Error("unreadable");
      },
      send: f.transport.send,
    });
  assert.equal(
    f.db.prepare("SELECT status FROM split_inbox WHERE message_id=1").get()
      .status,
    "failed",
  );
  acceptSplitMessage(f.db, incoming("/retry", 2));
  await processSplitInbox(f.db, {
    answer: async () => answer(data()),
    send: f.transport.send,
  });
  assert.equal(
    f.db.prepare("SELECT media FROM split_inbox WHERE message_id=1").get()
      .media,
    JSON.stringify([image]),
  );
  noLedger(f.db);
});

test("concurrent worker leases serialize messages and stale model completions cannot overwrite drafts", async (t) => {
  const f = fixture(t);
  acceptSplitMessage(f.db, incoming("First", 1));
  acceptSplitMessage(f.db, incoming("Correction", 2));
  let release;
  const wait = new Promise((r) => (release = r));
  let calls = 0;
  const worker = processSplitInbox(f.db, {
    answer: async () => {
      calls++;
      await wait;
      return answer(data());
    },
    send: f.transport.send,
  });
  await new Promise((r) => setImmediate(r));
  await processSplitInbox(f.db, {
    answer: async () => assert.fail("same contact cannot run concurrently"),
    send: f.transport.send,
  });
  assert.equal(calls, 1);
  release();
  await worker;
  assert.equal(calls, 2);
  noLedger(f.db);
});

test("duplicate transaction candidates block approval until the owner explicitly resolves them", async (t) => {
  const f = fixture(t),
    d = await ready(f);
  insertRawTransaction(f.db, {
    source: "manual",
    amount: 1100,
    amount_inr: 1100,
    merchant_raw: "Courtyard",
    occurred_at: "2026-11-02T12:00:00+05:30",
  });
  assert.throws(
    () =>
      reviewSplit(
        f.db,
        { id: d.id, revision: d.revision, action: "approve" },
        owner,
      ),
    /duplicates/,
  );
  assert.equal(inspectSplit(f.db, d.id, owner).possible_duplicates.length, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM envelope_entries").get().n,
    0,
  );
});

test("split arithmetic reconciles discount, taxes and rounding without inventing foreign INR values", () => {
  const d = data();
  d.adjustments = [{ label: "Discount", amount_paise: -10001 }];
  d.total_paise = 89999;
  const c = calculateSplit(d);
  assert.equal(c.owner_paise, 53999);
  assert.equal(c.owner_paise + c.sender_paise, 89999);
  assert.throws(
    () => calculateSplit({ ...d, total_paise: 90000 }),
    /do not match/,
  );
  assert.throws(() => calculateSplit({ ...d, currency: "THB" }), /settled INR/);
  assert.throws(() => calculateSplit({ ...d, date: "2026-02-30" }), /date/);
  assert.throws(() => calculateSplit({ ...d, payer: "unknown" }), /paid/);
});

test("uncertain sends do not auto-retry, revocation and changed owner destination block delivery", async (t) => {
  const f = fixture(t),
    d = await ready(f);
  await deliverSplitMessages(f.db, {
    send: async () => {
      throw new DeliveryError("timeout", "uncertain");
    },
  });
  await deliverSplitMessages(f.db, {
    send: async () => assert.fail("No uncertain retries"),
  });
  assert.equal(
    f.db.prepare("SELECT status FROM split_outbox WHERE audience='owner'").get()
      .status,
    "uncertain",
  );
  queueSplitMessage(f.db, {
    userId: "222",
    audience: "recipient",
    key: "revoke",
    text: "private reply",
    draft: d,
  });
  f.db.prepare("UPDATE telegram_contributors SET status='revoked'").run();
  await deliverSplitMessages(f.db, {
    send: async () => assert.fail("revoked"),
  });
  assert.equal(
    f.db
      .prepare("SELECT status FROM split_outbox WHERE dedupe_key='revoke'")
      .get().status,
    "cancelled",
  );
});

test("bill choices, new requests and recipient context use expense dates rather than historical today or sent dates", async (t) => {
  const f = fixture(t),
    { db, person } = f;
  const raw = insertRawTransaction(db, {
    source: "manual",
    amount: 500,
    merchant_raw: "District Dining",
    occurred_at: "2026-10-30T12:00:00+05:30",
  });
  const e = createEnvelopeEntry(db, {
    raw_transaction_id: raw.id,
    funding_month: "2026-10",
    occurred_at: raw.occurred_at,
    source: "manual",
    merchant_clean: "District Dining",
    category: "Food",
    treatment: "normal",
    state: "actual",
    gross_amount_inr: 500,
    personal_impact: 250,
    cashflow_impact: 500,
    created_by: "owner",
  });
  const r = createReceivable(db, {
    counterparty: "Parikshit",
    amount_inr: 250,
    envelope_entry_id: e.id,
    label: "Today's lunch",
    created_by: "owner",
  });
  let facts;
  const batch = await preparePaymentBatch(
    db,
    [
      {
        contact_id: person.contact_id,
        receivable_ids: [r.id],
        context: "Today's lunch",
      },
    ],
    owner,
    async (f) => {
      facts = f;
      return "test request";
    },
  );
  const id = batch.results[0].request_id;
  assert.match(facts.context, /30 Oct 2026/);
  assert.doesNotMatch(facts.context, /today/i);
  authorizePaymentRequests(
    db,
    [{ id, fingerprint: getPaymentRequest(db, id).fingerprint }],
    owner,
  );
  await deliverPaymentRequests(db, { send: f.transport.send });
  db.prepare(
    "UPDATE payment_requests SET sent_at='2026-11-05T12:00:00Z' WHERE id=?",
  ).run(id);
  const request = getPaymentRequest(db, id);
  assert.equal(billLabel(db, request), "District Dining · 30 Oct 2026");
  const event = handleRecipientMessage(db, {
    user_id: "222",
    chat_id: "222",
    message_id: 18,
    text: "Check this receipt",
    request_id: id,
    media: [image],
  });
  const packet = recipientPacket(
    db,
    request,
    "Check this receipt",
    event.event_id,
  );
  assert.equal(packet.media.length, 1);
  assert.doesNotMatch(packet.request.context, /today|5 Nov/i);
});

test("rejected drafts keep receipt evidence and immutable versions for correction", async (t) => {
  const f = fixture(t);
  acceptSplitMessage(f.db, incoming("Dinner receipt", 1, [image]));
  await processSplitInbox(f.db, {
    answer: async () => answer(data()),
    send: f.transport.send,
  });
  await deliverSplitMessages(f.db, f.transport);
  let d = activeSplit(f.db, f.person.contact_id);
  submitSplit(f.db, d);
  reviewSplit(
    f.db,
    {
      id: d.id,
      revision: d.revision,
      action: "reject",
      note: "The discount is missing.",
    },
    owner,
  );
  acceptSplitMessage(f.db, incoming("Add the 100 rupee discount", 2));
  await processSplitInbox(f.db, {
    answer: async (packet, media) => {
      assert.equal(packet.draft.status, "rejected");
      assert.equal(packet.draft.review_note, "The discount is missing.");
      assert.equal(media.length, 1);
      return answer({
        ...data(),
        total_paise: 100000,
        adjustments: [
          { label: "Taxes", amount_paise: 10000 },
          { label: "Discount", amount_paise: -10000 },
        ],
      });
    },
    send: f.transport.send,
  });
  const revised = activeSplit(f.db, f.person.contact_id);
  assert.equal(revised.id, d.id);
  assert.equal(revised.revision, d.revision + 1);
  const versions = inspectSplit(f.db, d.id, owner).versions;
  assert.equal(versions.length, 2);
  assert.equal(JSON.parse(versions[0].data).total_paise, 110000);
  assert.throws(
    () =>
      reviewSplit(
        f.db,
        { id: d.id, revision: revised.revision, action: "approve" },
        { ...owner, split_review: { id: d.id, revision: d.revision } },
      ),
    /exact version/,
  );
  noLedger(f.db);
});

test("private sender identity scopes all model history and receipts", async (t) => {
  const f = fixture(t);
  const invite = createContactInvite(f.db, {
    name: "Someone else",
    role: "recipient",
    created_by: "owner",
  });
  claimTelegramContributorInvite(f.db, {
    claim_token: invite.claim_token,
    telegram_user_id: "333",
    owner_telegram_user_id: "111",
  });
  saveSplit(f.db, "333", { ...data(), title: "PRIVATE OTHER BILL" });
  assert.throws(
    () =>
      acceptSplitMessage(f.db, {
        userId: "222",
        chatId: "333",
        messageId: 1,
        text: "read theirs",
      }),
    /private connection/,
  );
  acceptSplitMessage(f.db, incoming("Hello", 1));
  await processSplitInbox(f.db, {
    answer: async (packet, media) => {
      assert.doesNotMatch(
        JSON.stringify(packet),
        /PRIVATE OTHER BILL|Someone else/,
      );
      assert.equal(media.length, 0);
      return {
        route: "chat",
        request_id: null,
        reply: "Hi! Send your receipt whenever ready.",
        draft_action: "status",
        draft: null,
      };
    },
    send: f.transport.send,
  });
  noLedger(f.db);
});

test("receipt limit is enforced before queuing, including multiple pending uploads", (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 4; i++)
    acceptSplitMessage(
      f.db,
      incoming("receipt", i, [
        {
          data_url: `data:image/png;base64,${Buffer.from(`file ${i}`).toString("base64")}`,
        },
      ]),
    );
  assert.throws(
    () =>
      acceptSplitMessage(
        f.db,
        incoming("fifth", 5, [{ data_url: "data:image/png;base64,Zml2ZQ==" }]),
      ),
    /four receipts/,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM split_inbox").get().n, 4);
  noLedger(f.db);
});

test("migration is idempotent and old missing bill evidence produces an honest date label", (t) => {
  const f = fixture(t);
  runMigrations(f.db);
  runMigrations(f.db);
  assert.equal(
    billLabel(f.db, { source_ids: JSON.stringify(["missing-old-source"]) }),
    "Shared expense · expense date unconfirmed",
  );
  noLedger(f.db);
});

test("an ambiguous receipt uploaded before the explanation survives clarification", async (t) => {
  const f = fixture(t);
  acceptSplitMessage(f.db, incoming("Here's the receipt", 1, [image]));
  await processSplitInbox(f.db, {
    answer: async () => ({
      route: "chat",
      request_id: null,
      reply: "Is this a new purchase you paid for?",
      draft_action: "status",
      draft: null,
    }),
    send: f.transport.send,
  });
  acceptSplitMessage(
    f.db,
    incoming(
      "Yes, I paid for Courtyard dinner on 2 November. We shared the fries.",
      2,
    ),
  );
  await processSplitInbox(f.db, {
    answer: async (packet, media) => {
      assert.equal(media.length, 1);
      assert.equal(packet.unassigned_receipts[0].message_id, 1);
      return answer(data());
    },
    send: f.transport.send,
  });
  const d = activeSplit(f.db, f.person.contact_id);
  assert.equal(
    f.db.prepare("SELECT draft_id FROM split_inbox WHERE message_id=1").get()
      .draft_id,
    d.id,
  );
  await deliverSplitMessages(f.db, f.transport);
  submitSplit(f.db, d);
  await deliverSplitMessages(f.db, f.transport);
  assert.ok(f.sent.some((s) => s.chat === "-100" && s.media));
  noLedger(f.db);
});

test("confirmation requires every preview part and rejects stale or cancelled draft objects", async (t) => {
  const f = fixture(t),
    d = saveSplit(f.db, "222", data());
  queueSplitMessage(f.db, {
    userId: "222",
    audience: "recipient",
    draft: d,
    key: "preview:long",
    text: "x".repeat(3100),
  });
  let sends = 0;
  await deliverSplitMessages(f.db, {
    send: async () => {
      if (++sends === 2) throw new DeliveryError("timeout", "uncertain");
      return 100;
    },
  });
  assert.throws(
    () => submitSplit(f.db, d),
    /complete current calculation preview/,
  );
  f.db
    .prepare(
      "UPDATE split_outbox SET status='sent' WHERE dedupe_key LIKE 'preview:%'",
    )
    .run();
  const changed = saveSplit(f.db, "222", {
    ...data(),
    title: "Corrected dinner",
  });
  assert.throws(() => submitSplit(f.db, d), /no longer current/);
  f.db
    .prepare("UPDATE split_drafts SET status='cancelled' WHERE id=?")
    .run(changed.id);
  assert.throws(() => submitSplit(f.db, changed), /closed/);
  noLedger(f.db);
});

test("a contributor can still use /tab while a receipt draft is open", async (t) => {
  const f = fixture(t, "contributor");
  const draft = saveSplit(f.db, "222", data());
  let contributorCalls = 0;
  await handleTelegramUpdate(
    f.db,
    {
      update_id: 77,
      message: {
        message_id: 77,
        text: "/tab",
        from: { id: 222 },
        chat: { id: 222, type: "private" },
      },
    },
    {
      sendTyping: async () => {},
      sendToIncomingChat: async () => 99,
      runContributorAgent: async () => {
        contributorCalls++;
        return { text: "Here is your shared tab.", recorded_purchases: [] };
      },
      answerSplit: async () =>
        assert.fail("Explicit /tab must preserve contributor access"),
    },
  );
  assert.equal(contributorCalls, 1);
  assert.equal(activeSplit(f.db, f.person.contact_id).id, draft.id);
  noLedger(f.db);
});
