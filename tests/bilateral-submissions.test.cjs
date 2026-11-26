require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../src/db/schema");
const {
  createContactInvite,
  claimTelegramContributorInvite,
} = require("../src/telegram/access");
const {
  saveSplit,
  submitSplit,
  reviewSplit,
  inspectSplit,
  calculateSplit,
  splitPreview,
  activeSplit,
} = require("../src/payments/split-drafts");
const {
  queueSplitMessage,
  deliverSplitMessages,
} = require("../src/payments/split-outbox");
const { handleTelegramUpdate } = require("../src/telegram/bot");
const {
  getCounterpartyBalance,
  insertRawTransaction,
  createEnvelopeEntry,
  listEnvelopeEntries,
  createReceivable,
} = require("../src/db/v2-queries");
const owner = {
  role: "owner",
  actor: "synthetic-owner",
  source: "telegram",
  request_id: "synthetic-review",
};
// Entire scenarios are synthetic, including dates, amounts, titles and identities.
function data(payer = "aniket", basis = "owed_share") {
  return {
    title: "Orbit workshop",
    date: "2032-04-17",
    currency: "INR",
    payer,
    amount_basis: basis,
    total_paise: 24680,
    receipt_reference: null,
    items:
      basis === "owed_share"
        ? []
        : [
            {
              name: "Workshop materials",
              amount_paise: 24680,
              owner_parts: 1,
              total_parts: 4,
            },
          ],
    adjustments: [],
    unresolved: [],
  };
}
function fixture(t, role = "recipient") {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runMigrations(db);
  const env = {
    PAYMENT_REQUEST_DELIVERY_ENABLED: "true",
    TELEGRAM_OWNER_USER_ID: "111",
    TELEGRAM_CHAT_ID: "-100",
    TELEGRAM_WEBHOOK_SECRET: "synthetic-secret",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    db.close();
    for (const [k, v] of Object.entries(previous))
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const invite = createContactInvite(db, {
    name: "Avery",
    role,
    created_by: "synthetic-owner",
  });
  const person = claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: "222",
    owner_telegram_user_id: "111",
  }).contributor;
  let sequence = 200;
  const sent = [];
  const send = async (chat, text) => {
    sent.push({ chat, text });
    return ++sequence;
  };
  return { db, person, send, sent };
}
async function submit(f, value) {
  const d = saveSplit(f.db, "222", value);
  queueSplitMessage(f.db, {
    userId: "222",
    audience: "recipient",
    draft: d,
    key: `preview:synthetic:${d.id}:${d.revision}`,
    text: splitPreview(d),
  });
  await deliverSplitMessages(f.db, { send: f.send });
  submitSplit(f.db, d);
  await deliverSplitMessages(f.db, { send: f.send });
  return d;
}
function approve(f, d, extra = {}) {
  return reviewSplit(
    f.db,
    { id: d.id, revision: d.revision, action: "approve", ...extra },
    owner,
  );
}
function existing(f) {
  const raw = insertRawTransaction(f.db, {
    source: "gmail",
    amount: 493.6,
    currency: "INR",
    amount_inr: 493.6,
    merchant_raw: "Synthetic stationery",
    occurred_at: "2032-04-16T20:00:00Z",
    direction: "debit",
    raw_payload: "immutable synthetic evidence",
  });
  const entry = createEnvelopeEntry(f.db, {
    raw_transaction_id: raw.id,
    funding_month: "2032-04",
    occurred_at: raw.occurred_at,
    source: "gmail",
    treatment: "normal",
    gross_amount_inr: 493.6,
    personal_impact: 493.6,
    cashflow_impact: 493.6,
    created_by: "synthetic-owner",
  });
  return { raw, entry };
}
for (const payer of ["sender", "aniket"])
  for (const basis of ["bill_total", "owed_share"]) {
    test(`${payer} paid, ${basis}: approval changes the correct balance exactly once`, async (t) => {
      const f = fixture(t);
      const d = await submit(f, data(payer, basis));
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM envelope_entries").get().n,
        0,
      );
      assert.equal(getCounterpartyBalance(f.db, "Avery").net_balance_inr, 0);
      assert.throws(
        () =>
          reviewSplit(f.db, {
            id: d.id,
            revision: d.revision,
            action: "approve",
          }),
        /owner/i,
      );
      approve(f, d);
      approve(f, d);
      const sums = calculateSplit(data(payer, basis));
      const balance = getCounterpartyBalance(f.db, "Avery");
      assert.equal(
        balance.net_balance_inr,
        (payer === "sender" ? -sums.owner_paise : sums.sender_paise) / 100,
      );
      const entries = listEnvelopeEntries(f.db);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].personal_impact, sums.owner_paise / 100);
      assert.equal(
        entries[0].cashflow_impact,
        payer === "aniket" && basis === "bill_total" ? 246.8 : 0,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
        basis === "bill_total" ? 1 : 0,
      );
      assert.equal(entries[0].occurred_at.slice(0, 10), "2032-04-17");
      await deliverSplitMessages(f.db, { send: f.send });
      assert.ok(
        f.sent.some((m) =>
          m.text.includes(payer === "sender" ? "owed to you" : "owed to him"),
        ),
      );
      assert.equal(
        f.db.prepare("SELECT count(*) n FROM payment_requests").get().n,
        0,
      );
    });
  }
test("share-only reports reject contradictory item allocations and previews state uncertainty", () => {
  assert.throws(
    () =>
      calculateSplit({ ...data(), items: data("aniket", "bill_total").items }),
    /must not also contain/,
  );
  assert.throws(
    () => calculateSplit({ ...data(), payer: "unknown" }),
    /who paid/,
  );
  assert.throws(
    () => calculateSplit({ ...data(), date: "2032-02-30" }),
    /exact purchase date/,
  );
  assert.throws(
    () => calculateSplit({ ...data(), total_paise: 0 }),
    /amount owed/,
  );
  assert.throws(
    () => calculateSplit({ ...data(), currency: "USD" }),
    /settled INR/,
  );
  assert.match(
    splitPreview({
      data: JSON.stringify(data()),
      id: "synthetic",
      revision: 1,
    }),
    /full bill total unknown/,
  );
});
test("the payer receives the rounding remainder in either direction", () => {
  const d = {
    ...data("aniket", "bill_total"),
    total_paise: 101,
    items: [
      {
        name: "Synthetic materials",
        amount_paise: 101,
        owner_parts: 1,
        total_parts: 2,
      },
    ],
  };
  assert.deepEqual(calculateSplit(d), {
    total_paise: 101,
    owner_paise: 50,
    sender_paise: 51,
  });
  assert.deepEqual(calculateSplit({ ...d, payer: "sender" }), {
    total_paise: 101,
    owner_paise: 51,
    sender_paise: 50,
  });
  assert.equal(
    calculateSplit({ ...d, items: [{ ...d.items[0], owner_parts: 0 }] })
      .owner_paise,
    0,
  );
});
test("linking a reported share preserves bank evidence and supersedes only its interpretation", async (t) => {
  const f = fixture(t);
  const { raw, entry } = existing(f);
  const d = await submit(f, data());
  assert.ok(
    inspectSplit(f.db, d.id, owner).possible_duplicates.some(
      (r) => r.id === raw.id,
    ),
  );
  assert.throws(() => approve(f, d), /possible duplicates/i);
  approve(f, d, { existing_raw_transaction_id: raw.id });
  assert.deepEqual(
    f.db.prepare("SELECT * FROM raw_transactions WHERE id=?").get(raw.id),
    raw,
  );
  const active = listEnvelopeEntries(f.db);
  assert.equal(active.length, 1);
  assert.equal(active[0].supersedes_id, entry.id);
  assert.equal(active[0].personal_impact, 246.8);
  assert.equal(active[0].cashflow_impact, 493.6);
  assert.equal(active[0].receivable_amount, 246.8);
  assert.equal(getCounterpartyBalance(f.db, "Avery").net_balance_inr, 246.8);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
    1,
  );
});
test("existing allocations and invalid links cannot be overwritten by approval", async (t) => {
  const f = fixture(t);
  const { raw, entry } = existing(f);
  const d = await submit(f, data());
  assert.throws(
    () =>
      approve(f, d, {
        existing_raw_transaction_id: "missing",
        acknowledge_possible_duplicate: true,
      }),
    /existing debit/,
  );
  createReceivable(f.db, {
    envelope_entry_id: entry.id,
    counterparty: "Blair",
    label: "Synthetic prior allocation",
    amount_inr: 18.75,
    created_by: "synthetic-owner",
  });
  assert.throws(
    () => approve(f, d, { existing_raw_transaction_id: raw.id }),
    /already has a split/,
  );
  assert.equal(listEnvelopeEntries(f.db)[0].id, entry.id);
  assert.equal(getCounterpartyBalance(f.db, "Avery").net_balance_inr, 0);
});
test("a second share-only report is flagged even without a raw bank transaction", async (t) => {
  const f = fixture(t);
  approve(f, await submit(f, data()));
  const second = await submit(f, data());
  assert.ok(
    inspectSplit(f.db, second.id, owner).possible_duplicates.some(
      (r) => r.kind === "reported_share",
    ),
  );
  assert.throws(() => approve(f, second), /possible duplicates/i);
  assert.equal(listEnvelopeEntries(f.db).length, 1);
});
for (const role of ["recipient", "contributor"])
  test(`${role} uses conversational previews and owner review without direct writes`, async (t) => {
    const f = fixture(t, role);
    let packet;
    let count = 0;
    const sendInput = async (text, draft, action = "edit") =>
      handleTelegramUpdate(
        f.db,
        {
          update_id: ++count,
          message: {
            message_id: count,
            text,
            from: { id: 222 },
            chat: { id: 222, type: "private" },
            date: 1965816000,
          },
        },
        {
          runOwnerAgent: async () => assert.fail("No owner privilege"),
          runContributorAgent: async () => assert.fail("No direct write route"),
          answerSplit: async (p) => {
            packet = p;
            return {
              route: "draft",
              request_id: null,
              reply: "Thanks, here is the proposal.",
              draft_action: action,
              draft,
            };
          },
          sendConversationMessage: f.send,
        },
      );
    await sendInput("I owe Aniket for the workshop.", data());
    assert.equal(packet.sender, "Avery");
    assert.equal(packet.shared_tab !== null, role === "contributor");
    await sendInput("Yes, send that for approval.", null, "submit");
    assert.equal(packet.history.length, 1);
    assert.equal(activeSplit(f.db, f.person.contact_id).status, "submitted");
    assert.equal(listEnvelopeEntries(f.db).length, 0);
    assert.ok(
      f.sent.some(
        (m) => m.chat === "-100" && m.text.includes("Avery owes Aniket"),
      ),
    );
  });

test("full bilateral history is fetched only for contributors and leaves drafts intact", async (t) => {
  const f = fixture(t, "contributor");
  const d = saveSplit(f.db, "222", data());
  const views = [];
  await handleTelegramUpdate(
    f.db,
    {
      update_id: 91,
      message: {
        message_id: 91,
        text: "Show our full lifetime history",
        from: { id: 222 },
        chat: { id: 222, type: "private" },
      },
    },
    {
      answerSplit: async (packet) => {
        views.push(packet.shared_tab.view);
        return {
          route: "chat",
          request_id: null,
          tab_view: "full",
          reply: "Here is your bilateral history.",
          draft_action: "status",
          draft: null,
        };
      },
      sendConversationMessage: f.send,
    },
  );
  assert.deepEqual(views, ["current", "full"]);
  assert.equal(activeSplit(f.db, f.person.contact_id).id, d.id);
  assert.equal(listEnvelopeEntries(f.db).length, 0);
});
test("recipient cannot request contributor history through a model response", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await handleTelegramUpdate(
    f.db,
    {
      update_id: 92,
      message: {
        message_id: 92,
        text: "Show all records",
        from: { id: 222 },
        chat: { id: 222, type: "private" },
      },
    },
    {
      answerSplit: async (packet) => {
        calls++;
        assert.equal(packet.shared_tab, null);
        assert.deepEqual(packet.legacy_history, []);
        return {
          route: "chat",
          request_id: null,
          tab_view: "full",
          reply: "I can discuss your requests and proposals.",
          draft_action: "status",
          draft: null,
        };
      },
      sendConversationMessage: f.send,
    },
  );
  assert.equal(calls, 1);
});
test("a full bill can link its debit without duplicating spending, and rejects a mismatched total", async (t) => {
  const f = fixture(t);
  const { raw } = existing(f);
  const d = await submit(f, data("aniket", "bill_total"));
  assert.throws(
    () => approve(f, d, { existing_raw_transaction_id: raw.id }),
    /does not match/,
  );
  reviewSplit(
    f.db,
    { id: d.id, revision: d.revision, action: "reject" },
    owner,
  );
  const full = data("aniket", "bill_total");
  full.total_paise = 49360;
  full.items[0].amount_paise = 49360;
  const changed = await submit(f, full);
  assert.throws(
    () => approve(f, d, { existing_raw_transaction_id: raw.id }),
    /no longer current/,
  );
  approve(f, changed, { existing_raw_transaction_id: raw.id });
  assert.equal(listEnvelopeEntries(f.db)[0].personal_impact, 123.4);
  assert.equal(listEnvelopeEntries(f.db)[0].receivable_amount, 370.2);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM raw_transactions").get().n,
    1,
  );
});
