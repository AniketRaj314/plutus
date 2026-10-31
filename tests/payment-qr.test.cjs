require("ts-node/register");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { PNG } = require("pngjs");
const jsQR = require("jsqr");
const { runMigrations } = require("../src/db/schema");
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
  listPaymentRequests,
} = require("../src/payments/requests");
const { renderPaymentMessage } = require("../src/payments/messages");
const {
  deliverPaymentRequests,
  DeliveryError,
  paymentDeliveryHealth,
} = require("../src/payments/delivery");
const {
  upiQrPayload,
  renderPaymentQr,
  sendPaymentQr,
  deliverPaymentQrs,
  managePaymentQr,
} = require("../src/payments/qr");
const {
  handleRecipientMessage,
  isPaymentReply,
} = require("../src/payments/replies");
const owner = {
  role: "owner",
  actor: "test-owner",
  source: "telegram",
  request_id: "test-turn",
};

function env(t, key, value) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
async function fixture(t, { sent = true } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runMigrations(db);
  t.after(() => db.close());
  env(t, "PAYMENT_REQUEST_DELIVERY_ENABLED", "true");
  env(t, "PAYMENT_REQUEST_UPI_ID", "9969596700@ptyes");
  const invite = createContactInvite(db, { name: "Vee", created_by: "test" });
  const person = claimTelegramContributorInvite(db, {
    claim_token: invite.claim_token,
    telegram_user_id: "222",
    owner_telegram_user_id: "111",
  }).contributor;
  const entry = createEnvelopeEntry(db, {
    funding_month: "2026-10",
    treatment: "split",
    gross_amount_inr: 2000,
    personal_impact: 1025.21,
    cashflow_impact: 2000,
    receivable_amount: 974.79,
    state: "actual",
    merchant_clean: "Lunch",
    created_by: "telegram_user",
  });
  const receivable = createReceivable(db, {
    envelope_entry_id: entry.id,
    counterparty: "Vee",
    label: "Lunch",
    amount_inr: 974.79,
    created_by: "telegram_user",
  });
  const batch = await preparePaymentBatch(
    db,
    [
      {
        contact_id: person.contact_id,
        receivable_ids: [receivable.id],
        context: "our lunch",
      },
    ],
    owner,
    async (f) =>
      renderPaymentMessage(f, {
        greeting: "Hope you're well!",
        closing: "Thanks!",
      }),
  );
  assert.equal(batch.results[0].error, undefined);
  const row = getPaymentRequest(db, batch.results[0].request_id);
  if (sent) {
    authorizePaymentRequests(
      db,
      [{ id: row.id, fingerprint: row.fingerprint }],
      owner,
    );
    await deliverPaymentRequests(db, { send: async () => 99 });
  }
  return {
    db,
    person,
    receivable,
    row: getPaymentRequest(db, row.id),
    at: new Date(),
  };
}
const qrState = (db, row) =>
  db.prepare("SELECT * FROM payment_request_qr WHERE request_id=?").get(row.id);
function decode(png) {
  const image = PNG.sync.read(png);
  const qr = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.ok(qr, "actual PNG must decode with an independent QR decoder");
  return new URL(qr.data);
}

test("generated PNG decodes to the exact UPI amount and destination, without private bill data", async () => {
  const uri = upiQrPayload(97479, "9969596700@ptyes");
  const url = decode(await renderPaymentQr(uri));
  assert.equal(url.protocol, "upi:");
  assert.equal(url.hostname, "pay");
  assert.equal(url.searchParams.get("pa"), "9969596700@ptyes");
  assert.equal(url.searchParams.get("am"), "974.79");
  assert.equal(url.searchParams.get("pn"), "Aniket");
  assert.equal(url.searchParams.get("cu"), "INR");
  assert.equal(url.searchParams.get("tn"), "Shared expense payment");
  assert.equal(url.searchParams.has("mc"), false);
  assert.match(uri, /Shared%20expense%20payment/);
  assert.equal(
    new URL(upiQrPayload(1, "valid@bank")).searchParams.get("am"),
    "0.01",
  );
  assert.equal(
    new URL(upiQrPayload(100, "valid@bank")).searchParams.get("am"),
    "1.00",
  );
  for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => upiQrPayload(amount, "valid@bank"));
  assert.throws(() => upiQrPayload(100, "valid@bank&pa=evil@bank"));
});

test("QR is additional, waits for authorized text delivery, and preserves the copyable UPI", async (t) => {
  const { db, row, person } = await fixture(t, { sent: false });
  const before = getCounterpartyBalance(db, person.contact_id);
  assert.match(row.message, /₹974\.79/);
  assert.match(
    row.message,
    /`9969596700@ptyes` \(click on the UPI ID to copy\)/,
  );
  await deliverPaymentQrs(db, {
    send: async () => assert.fail("draft must not send"),
  });
  assert.equal(qrState(db, row).status, "waiting");
  authorizePaymentRequests(
    db,
    [{ id: row.id, fingerprint: row.fingerprint }],
    owner,
  );
  await deliverPaymentQrs(db, {
    send: async () => assert.fail("text must be sent first"),
  });
  let textSends = 0;
  await deliverPaymentRequests(db, {
    send: async (_chat, text) => {
      textSends++;
      assert.equal(text, row.message);
      return 99;
    },
  });
  let photos = 0;
  const send = async (chat, image, caption, replyTo) => {
    photos++;
    assert.equal(chat, "222");
    assert.equal(replyTo, 99);
    assert.equal(decode(image).searchParams.get("am"), "974.79");
    assert.match(caption, /₹974\.79/);
    assert.match(caption, /`9969596700@ptyes` \(click on the UPI ID to copy\)/);
    return 100;
  };
  await deliverPaymentQrs(db, { send });
  await deliverPaymentQrs(db, { send });
  await deliverPaymentRequests(db, {
    send: async () => assert.fail("text must not repeat"),
  });
  assert.equal(photos, 1);
  assert.equal(textSends, 1);
  assert.equal(listPaymentRequests(db)[0].qr.status, "sent");
  assert.deepEqual(getCounterpartyBalance(db, person.contact_id), before);
  assert.ok(
    paymentDeliveryHealth(db).qr_delivery.some(
      (r) => r.status === "sent" && r.count === 1,
    ),
  );
});

test("QR image replies attach to the bill and cannot cross contact boundaries", async (t) => {
  const { db, row, person } = await fixture(t);
  await deliverPaymentQrs(db, { send: async () => 101 });
  assert.equal(isPaymentReply(db, person.contact_id, 101), true);
  assert.equal(isPaymentReply(db, "another-contact", 101), false);
  const result = handleRecipientMessage(db, {
    user_id: "222",
    chat_id: "222",
    message_id: 2,
    reply_to_message_id: 101,
    text: "How did you calculate this?",
  });
  assert.equal(
    db
      .prepare("SELECT request_id FROM payment_chat_events WHERE id=?")
      .get(result.event_id).request_id,
    row.id,
  );
});

test("uncertain QR sends never resend text or retry automatically, approved image-only retry is audited", async (t) => {
  const { db, row } = await fixture(t);
  let sends = 0;
  const send = async () => {
    sends++;
    throw new DeliveryError("transport_outcome_unknown", "uncertain");
  };
  await deliverPaymentQrs(db, { send });
  await deliverPaymentQrs(db, { send });
  assert.equal(sends, 1);
  assert.equal(qrState(db, row).status, "uncertain");
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
  assert.throws(() => managePaymentQr(db, row.id, "retry"), /authenticated/);
  managePaymentQr(db, row.id, "retry", owner);
  await deliverPaymentQrs(db, { send: async () => 102 });
  assert.equal(qrState(db, row).status, "sent");
  assert.equal(getPaymentRequest(db, row.id).telegram_message_id, 99);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM payment_audit WHERE action='qr_retry'")
      .get().n,
    1,
  );
});

test("known QR rate limits retry after the delay; disabled delivery makes no calls", async (t) => {
  const { db, row, at } = await fixture(t);
  let calls = 0;
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "false";
  await deliverPaymentQrs(db, {
    render: async () => assert.fail("disabled"),
    send: async () => assert.fail("disabled"),
  });
  process.env.PAYMENT_REQUEST_DELIVERY_ENABLED = "true";
  const send = async () => {
    if (++calls === 1) throw new DeliveryError("rate_limited", "retry", 60);
    return 103;
  };
  await deliverPaymentQrs(db, { now: at, send });
  await deliverPaymentQrs(db, { now: new Date(at.getTime() + 1000), send });
  assert.equal(calls, 1);
  await deliverPaymentQrs(db, { now: new Date(at.getTime() + 61000), send });
  assert.equal(calls, 2);
  assert.equal(qrState(db, row).status, "sent");
});

for (const change of ["payment", "destination", "revocation", "expiry"]) {
  test(`pending QR fails closed after ${change}`, async (t) => {
    const { db, row, person, receivable } = await fixture(t);
    if (change === "payment")
      updateReceivable(db, receivable.id, {
        received_inr: 974.79,
        status: "received",
      });
    if (change === "destination")
      process.env.PAYMENT_REQUEST_UPI_ID = "other@bank";
    if (change === "revocation")
      setContactAccess(db, person.contact_id, "revoked", "test");
    if (change === "expiry")
      db.prepare(
        "UPDATE payment_requests SET expires_at='2000-01-01' WHERE id=?",
      ).run(row.id);
    await deliverPaymentQrs(db, { send: async () => assert.fail("stale QR") });
    assert.equal(qrState(db, row).status, "stale");
  });
}

test("access is rechecked after rendering and concurrent workers cannot duplicate images", async (t) => {
  const { db, row, person } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let renders = 0;
  let sends = 0;
  const options = {
    render: async (uri) => {
      renders++;
      await gate;
      return renderPaymentQr(uri);
    },
    send: async () => {
      sends++;
      return 104;
    },
  };
  const first = deliverPaymentQrs(db, options);
  await deliverPaymentQrs(db, options);
  assert.equal(renders, 1);
  setContactAccess(db, person.contact_id, "revoked", "test");
  release();
  await first;
  assert.equal(sends, 0);
  assert.equal(qrState(db, row).status, "stale");
});

test("render failure leaves the text usable, and migration never backfills historical requests", async (t) => {
  const { db, row } = await fixture(t);
  await deliverPaymentQrs(db, {
    render: async () => {
      throw new Error("bad renderer");
    },
    send: async () => assert.fail("render failed"),
  });
  assert.equal(qrState(db, row).last_error_code, "qr_generation_failed");
  assert.equal(getPaymentRequest(db, row.id).status, "sent");
  db.prepare("DELETE FROM payment_request_qr WHERE request_id=?").run(row.id);
  runMigrations(db);
  await deliverPaymentQrs(db, {
    send: async () => assert.fail("no historic sends"),
  });
  assert.equal(listPaymentRequests(db)[0].qr, null);
});

test("crash after photo acceptance recovers as uncertain without automatic retry", async (t) => {
  const { db, row } = await fixture(t);
  db.exec(
    "CREATE TRIGGER qr_save_failure BEFORE UPDATE ON payment_request_qr WHEN NEW.status='sent' BEGIN SELECT RAISE(FAIL,'simulated crash'); END",
  );
  await assert.rejects(
    deliverPaymentQrs(db, { send: async () => 105 }),
    /simulated crash/,
  );
  assert.equal(qrState(db, row).status, "sending");
  db.exec("DROP TRIGGER qr_save_failure");
  db.prepare(
    "UPDATE payment_request_qr SET lease_until='2000-01-01' WHERE request_id=?",
  ).run(row.id);
  await deliverPaymentQrs(db, {
    send: async () => assert.fail("no uncertain retry"),
  });
  assert.equal(qrState(db, row).status, "uncertain");
});

test("photo transport uploads a PNG with copyable UPI, a reply link and fixed error classification", async (t) => {
  env(t, "TELEGRAM_BOT_TOKEN", "unit-test-only");
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 107 } }),
    };
  });
  const image = await renderPaymentQr(upiQrPayload(100, "9969596700@ptyes"));
  assert.equal(
    await sendPaymentQr(
      "222",
      image,
      "₹1.00\n`9969596700@ptyes` (click on the UPI ID to copy)",
      99,
    ),
    107,
  );
  assert.match(captured.url, /\/sendPhoto$/);
  const form = captured.options.body;
  assert.equal(form.get("chat_id"), "222");
  assert.equal(form.get("disable_notification"), "true");
  assert.equal(form.get("photo").type, "image/png");
  assert.equal(
    decode(Buffer.from(await form.get("photo").arrayBuffer())).searchParams.get(
      "am",
    ),
    "1.00",
  );
  assert.match(form.get("caption"), /<code>9969596700@ptyes<\/code>/);
  assert.equal(JSON.parse(form.get("reply_parameters")).message_id, 99);
  globalThis.fetch = async () => {
    throw new Error("secret provider detail");
  };
  await assert.rejects(
    sendPaymentQr("222", image, "QR", 99),
    (error) =>
      error.code === "transport_outcome_unknown" &&
      error.outcome === "uncertain" &&
      !error.message.includes("secret"),
  );
});
