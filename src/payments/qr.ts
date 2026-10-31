import QRCode from "qrcode";
import type Database from "better-sqlite3";
import { renderTelegramChunks } from "../telegram/render";
import { DeliveryError, telegramMessageResult } from "./delivery";
import {
  auditRequest,
  currentFingerprint,
  getPaymentRequest,
  requireOwner,
  type OwnerContext,
  type PaymentRequest,
} from "./requests";

export function upiQrPayload(amountPaise: number, upi: string): string {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0)
    throw new Error("Invalid QR amount");
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/.test(upi))
    throw new Error("Invalid QR payment destination");
  // Integer arithmetic preserves the authorized paise amount, including very large safe integers.
  const amount = `${Math.floor(amountPaise / 100)}.${String(amountPaise % 100).padStart(2, "0")}`;
  const fields = {
    pa: upi,
    pn: "Aniket",
    am: amount,
    cu: "INR",
    tn: "Shared expense payment",
  };
  return (
    "upi://pay?" +
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&")
  );
}

export function paymentQrDetails(row: PaymentRequest) {
  const snapshot = JSON.parse(row.snapshot);
  if (snapshot.amount_paise !== row.amount_paise)
    throw new Error("QR amount does not match request");
  const uri = upiQrPayload(row.amount_paise, snapshot.upi);
  const amount = new URL(uri).searchParams.get("am");
  return {
    uri,
    caption: `Optional scan-to-pay QR\nAmount: ₹${amount}\nAniket's UPI: \`${snapshot.upi}\` (click on the UPI ID to copy)\n\nScan from another screen, or save this image and choose it in your UPI app's scanner. If your app limits gallery payments, use the UPI ID above. Check the payee and amount before paying.`,
  };
}

export const renderPaymentQr = (uri: string): Promise<Buffer> =>
  QRCode.toBuffer(uri, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 8,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });

export type SendPaymentQr = (
  chatId: string,
  png: Buffer,
  caption: string,
  replyTo: number,
) => Promise<number>;
export const sendPaymentQr: SendPaymentQr = async (
  chatId,
  png,
  caption,
  replyTo,
) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new DeliveryError("bot_not_configured", "failed");
  const chunks = renderTelegramChunks(caption);
  if (caption.length > 1024 || chunks.length !== 1)
    throw new DeliveryError("qr_caption_too_long", "failed");
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set(
    "photo",
    new Blob([new Uint8Array(png)], { type: "image/png" }),
    "payment-qr.png",
  );
  form.set("caption", chunks[0]);
  form.set("parse_mode", "HTML");
  form.set("disable_notification", "true");
  form.set(
    "reply_parameters",
    JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }),
  );
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new DeliveryError("transport_outcome_unknown", "uncertain");
  }
  return telegramMessageResult(response);
};

interface QrDelivery {
  request_id: string;
  fingerprint: string;
  status: string;
  attempts: number;
}

function stillCurrent(
  db: Database.Database,
  row: PaymentRequest,
  qr: QrDelivery,
  at: string,
): boolean {
  try {
    return (
      row.status === "sent" &&
      Boolean(row.authorized_by) &&
      row.telegram_message_id !== null &&
      row.expires_at > at &&
      row.fingerprint === qr.fingerprint &&
      currentFingerprint(db, row) === qr.fingerprint
    );
  } catch {
    return false;
  }
}

export async function deliverPaymentQrs(
  db: Database.Database,
  options: {
    send?: SendPaymentQr;
    render?: typeof renderPaymentQr;
    now?: Date;
  } = {},
): Promise<void> {
  const time = () => options.now ?? new Date();
  db.prepare(
    "UPDATE payment_request_qr SET status='uncertain',last_error_code='interrupted_send',lease_until=NULL WHERE status='sending' AND lease_until<=?",
  ).run(time().toISOString());
  if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") return;
  // Only rows explicitly prepared with QR support are eligible. Never backfill old sent requests.
  const candidates = db
    .prepare(
      `SELECT q.request_id FROM payment_request_qr q JOIN payment_requests p ON p.id=q.request_id
    WHERE q.status IN ('waiting','queued') AND q.next_attempt_at<=? AND p.status='sent' ORDER BY p.sent_at LIMIT 10`,
    )
    .all(time().toISOString()) as Array<{ request_id: string }>;
  for (const candidate of candidates) {
    if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") break;
    const qr = db.transaction(() => {
      const qr = db
        .prepare(
          "SELECT * FROM payment_request_qr WHERE request_id=? AND status IN ('waiting','queued')",
        )
        .get(candidate.request_id) as QrDelivery | undefined;
      if (!qr) return undefined;
      const row = getPaymentRequest(db, qr.request_id);
      if (!stillCurrent(db, row, qr, time().toISOString())) {
        db.prepare(
          "UPDATE payment_request_qr SET status='stale',last_error_code='details_changed' WHERE request_id=?",
        ).run(qr.request_id);
        return undefined;
      }
      db.prepare(
        "UPDATE payment_request_qr SET status='sending',attempts=attempts+1,lease_until=? WHERE request_id=?",
      ).run(new Date(time().getTime() + 120000).toISOString(), qr.request_id);
      return qr;
    })();
    if (!qr) continue;
    const row = getPaymentRequest(db, qr.request_id);
    let image: Buffer;
    let details: ReturnType<typeof paymentQrDetails>;
    try {
      details = paymentQrDetails(row);
      image = await (options.render ?? renderPaymentQr)(details.uri);
    } catch {
      db.prepare(
        "UPDATE payment_request_qr SET status='failed',last_error_code='qr_generation_failed',lease_until=NULL WHERE request_id=?",
      ).run(row.id);
      continue;
    }
    // Rendering yields to the event loop; permissions or financial facts may have changed meanwhile.
    if (
      !db
        .prepare(
          "SELECT 1 FROM payment_request_qr WHERE request_id=? AND status='sending' AND attempts=? AND lease_until>?",
        )
        .get(row.id, qr.attempts + 1, time().toISOString())
    )
      continue;
    if (
      !stillCurrent(db, getPaymentRequest(db, row.id), qr, time().toISOString())
    ) {
      db.prepare(
        "UPDATE payment_request_qr SET status='stale',last_error_code='details_changed',lease_until=NULL WHERE request_id=?",
      ).run(row.id);
      continue;
    }
    if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") {
      db.prepare(
        "UPDATE payment_request_qr SET status='queued',lease_until=NULL WHERE request_id=?",
      ).run(row.id);
      break;
    }
    let messageId: number;
    try {
      messageId = await (options.send ?? sendPaymentQr)(
        JSON.parse(row.snapshot).connection.chat_id,
        image,
        details.caption,
        row.telegram_message_id!,
      );
      if (!Number.isInteger(messageId))
        throw new DeliveryError("invalid_send_result", "uncertain");
    } catch (error) {
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("transport_outcome_unknown", "uncertain");
      const status =
        failure.outcome === "retry" && qr.attempts + 1 < 5
          ? "queued"
          : failure.outcome === "uncertain"
            ? "uncertain"
            : "failed";
      db.prepare(
        "UPDATE payment_request_qr SET status=?,last_error_code=?,next_attempt_at=?,lease_until=NULL WHERE request_id=?",
      ).run(
        status,
        failure.code,
        new Date(time().getTime() + failure.retryAfter * 1000).toISOString(),
        row.id,
      );
      continue;
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE payment_request_qr SET status='sent',telegram_message_id=?,sent_at=?,last_error_code=NULL,lease_until=NULL WHERE request_id=?",
      ).run(messageId, time().toISOString(), row.id);
      auditRequest(db, row.id, "qr_sent", "worker", time());
    })();
  }
}

export function managePaymentQr(
  db: Database.Database,
  id: string,
  action: "cancel" | "retry",
  context?: OwnerContext,
  now = new Date(),
) {
  const owner = requireOwner(context);
  const qr = db
    .prepare("SELECT * FROM payment_request_qr WHERE request_id=?")
    .get(id) as QrDelivery | undefined;
  if (!qr) throw new Error("No QR was prepared for this request");
  if (action === "cancel") {
    if (!["waiting", "queued", "failed", "stale"].includes(qr.status))
      throw new Error("Cannot cancel a QR that may have been sent");
    db.prepare(
      "UPDATE payment_request_qr SET status='cancelled' WHERE request_id=?",
    ).run(id);
  } else {
    if (!["failed", "uncertain"].includes(qr.status))
      throw new Error("Only failed or uncertain QR delivery can be retried");
    if (!stillCurrent(db, getPaymentRequest(db, id), qr, now.toISOString()))
      throw new Error(
        "QR details changed or authorization expired; do not resend",
      );
    db.prepare(
      "UPDATE payment_request_qr SET status='queued',next_attempt_at=?,lease_until=NULL WHERE request_id=?",
    ).run(now.toISOString(), id);
  }
  auditRequest(
    db,
    id,
    `qr_${action}`,
    `${owner.actor}:${owner.request_id}`,
    now,
  );
  return db
    .prepare(
      "SELECT request_id,status,last_error_code FROM payment_request_qr WHERE request_id=?",
    )
    .get(id);
}
