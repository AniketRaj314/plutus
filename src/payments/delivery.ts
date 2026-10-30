import type Database from "better-sqlite3";
import { renderTelegramChunks } from "../telegram/render";
import {
  auditRequest,
  currentFingerprint,
  type PaymentRequest,
} from "./requests";

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "failed" | "retry" | "uncertain" | "blocked",
    readonly retryAfter = 60,
  ) {
    super(code);
  }
}
export type SendPaymentMessage = (
  chatId: string,
  message: string,
) => Promise<number>;

export const sendPaymentMessage: SendPaymentMessage = async (
  chatId,
  message,
) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new DeliveryError("bot_not_configured", "failed");
  const chunks = renderTelegramChunks(message);
  if (chunks.length !== 1)
    throw new DeliveryError("message_too_long", "failed");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[0],
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch {
    throw new DeliveryError("transport_outcome_unknown", "uncertain");
  }
  let body: {
    ok?: boolean;
    error_code?: number;
    parameters?: { retry_after?: number };
    result?: { message_id?: number };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new DeliveryError("response_outcome_unknown", "uncertain");
  }
  if (response.ok && body.ok && Number.isInteger(body.result?.message_id))
    return body.result!.message_id!;
  if (body.error_code === 429)
    throw new DeliveryError(
      "rate_limited",
      "retry",
      Math.max(1, body.parameters?.retry_after ?? 60),
    );
  if (body.error_code === 403)
    throw new DeliveryError("recipient_unreachable", "blocked");
  if (body.error_code === 400 || body.error_code === 401)
    throw new DeliveryError("telegram_rejected", "failed");
  throw new DeliveryError("telegram_outcome_unknown", "uncertain");
};

export async function deliverPaymentRequests(
  db: Database.Database,
  options: {
    send?: SendPaymentMessage;
    now?: Date;
    limit?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  // A previous process may have sent successfully and died before saving the ID.
  db.transaction(() => {
    const expired = db
      .prepare(
        "SELECT id FROM payment_requests WHERE status='sending' AND lease_until <= ?",
      )
      .all(at) as Array<{ id: string }>;
    for (const row of expired) {
      db.prepare(
        "UPDATE payment_requests SET status='uncertain',last_error_code='interrupted_send' WHERE id=?",
      ).run(row.id);
      db.prepare(
        "UPDATE payment_attempts SET outcome='uncertain',error_code='interrupted_send',finished_at=? WHERE request_id=? AND outcome IS NULL",
      ).run(at, row.id);
      auditRequest(db, row.id, "delivery_uncertain", "worker", now);
    }
  })();
  if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") return;
  const candidates = db
    .prepare(
      "SELECT id FROM payment_requests WHERE status='queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?",
    )
    .all(at, Math.min(options.limit ?? 10, 20)) as Array<{ id: string }>;
  for (const candidate of candidates) {
    const now = options.now ?? new Date();
    const at = now.toISOString();
    if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") break;
    const row = db.transaction(() => {
      const pending = db
        .prepare(
          "SELECT * FROM payment_requests WHERE id=? AND status='queued'",
        )
        .get(candidate.id) as PaymentRequest | undefined;
      if (!pending) return undefined;
      try {
        if (
          !pending.authorized_by ||
          pending.expires_at <= at ||
          currentFingerprint(db, pending) !== pending.fingerprint
        )
          throw new Error("stale");
        const snapshot = JSON.parse(pending.snapshot);
        if (
          snapshot.connection?.status !== "active" ||
          snapshot.connection?.delivery_status !== "ready"
        )
          throw new Error("revoked");
      } catch {
        db.prepare(
          "UPDATE payment_requests SET status='stale',last_error_code='details_changed' WHERE id=?",
        ).run(pending.id);
        auditRequest(db, pending.id, "stale_before_send", "worker", now);
        return undefined;
      }
      db.prepare(
        "UPDATE payment_requests SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?",
      ).run(new Date(now.getTime() + 120000).toISOString(), pending.id);
      db.prepare(
        "INSERT INTO payment_attempts(request_id,attempt,started_at) VALUES (?,?,?)",
      ).run(pending.id, pending.attempts + 1, at);
      return pending;
    })();
    if (!row) continue;
    let messageId: number;
    try {
      messageId = await (options.send ?? sendPaymentMessage)(
        JSON.parse(row.snapshot).connection.chat_id,
        row.message,
      );
      if (!Number.isInteger(messageId))
        throw new DeliveryError("invalid_send_result", "uncertain");
    } catch (error) {
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("transport_outcome_unknown", "uncertain");
      const status =
        failure.outcome === "retry" && row.attempts + 1 < 5
          ? "queued"
          : failure.outcome === "uncertain"
            ? "uncertain"
            : "failed";
      db.transaction(() => {
        db.prepare(
          "UPDATE payment_requests SET status=?,last_error_code=?,lease_until=NULL,next_attempt_at=? WHERE id=? AND status='sending'",
        ).run(
          status,
          failure.code,
          new Date(now.getTime() + failure.retryAfter * 1000).toISOString(),
          row.id,
        );
        db.prepare(
          "UPDATE payment_attempts SET outcome=?,error_code=?,finished_at=? WHERE request_id=? AND attempt=?",
        ).run(status, failure.code, at, row.id, row.attempts + 1);
        if (failure.outcome === "blocked") {
          db.prepare(
            "UPDATE telegram_contributors SET delivery_status='blocked' WHERE contact_id=?",
          ).run(row.contact_id);
          db.prepare("UPDATE contacts SET version=version+1 WHERE id=?").run(
            row.contact_id,
          );
        }
        auditRequest(db, row.id, `delivery:${status}`, "worker", now);
      })();
      continue;
    }
    // A persistence error here leaves 'sending' intact, recovered as uncertain.
    db.transaction(() => {
      db.prepare(
        "UPDATE payment_requests SET status='sent',telegram_message_id=?,sent_at=?,lease_until=NULL,last_error_code=NULL WHERE id=?",
      ).run(messageId, at, row.id);
      db.prepare(
        "UPDATE payment_attempts SET outcome='sent',finished_at=?,telegram_message_id=? WHERE request_id=? AND attempt=?",
      ).run(at, messageId, row.id, row.attempts + 1);
      auditRequest(db, row.id, "sent", "worker", now);
    })();
  }
}

export function paymentDeliveryHealth(db: Database.Database) {
  return {
    enabled: process.env.PAYMENT_REQUEST_DELIVERY_ENABLED === "true",
    counts: db
      .prepare(
        "SELECT status,COUNT(*) AS count FROM payment_requests GROUP BY status",
      )
      .all(),
  };
}
