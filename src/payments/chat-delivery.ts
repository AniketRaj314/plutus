import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DeliveryError,
  sendPaymentMessage,
  type SendPaymentMessage,
} from "./delivery";
import {
  requireOwner,
  type OwnerContext,
  type PaymentRequest,
} from "./requests";
import { getTelegramRecipient } from "../telegram/access";
import { plain } from "./messages";

export interface ChatDelivery {
  id: string;
  event_id: number | null;
  request_id: string;
  contact_id: string;
  kind: "owner_alert" | "recipient_reply" | "owner_relay";
  text: string;
  chat_id: string;
  thread_id: number | null;
  reply_to_message_id: number | null;
  status: string;
  connection_user_id: string | null;
  contact_version: number | null;
  attempts: number;
  telegram_message_id: number | null;
}

export function queueChatMessage(
  db: Database.Database,
  input: {
    request: PaymentRequest;
    event_id?: number;
    kind: ChatDelivery["kind"];
    dedupe_key: string;
    text: string;
    reply_to_message_id?: number;
  },
): ChatDelivery {
  const existing = db
    .prepare("SELECT * FROM payment_chat_outbox WHERE dedupe_key=?")
    .get(input.dedupe_key) as ChatDelivery | undefined;
  if (existing) return existing;
  const connection = db
    .prepare(
      "SELECT telegram_user_id,private_chat_id FROM telegram_contributors WHERE contact_id=? AND status='active'",
    )
    .get(input.request.contact_id) as
    | { telegram_user_id: string; private_chat_id: string }
    | undefined;
  if (!connection) throw new Error("Recipient connection is no longer active");
  const version = (
    db
      .prepare("SELECT version FROM contacts WHERE id=?")
      .get(input.request.contact_id) as { version: number }
  ).version;
  const owner = input.kind === "owner_alert";
  const ownerChat =
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_OWNER_USER_ID?.trim();
  if (owner && !ownerChat)
    throw new Error("Owner notification destination is not configured");
  const thread =
    owner && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_THREAD_ID
      ? Number(process.env.TELEGRAM_THREAD_ID)
      : null;
  const id = randomUUID();
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO payment_chat_outbox(id,event_id,request_id,contact_id,kind,dedupe_key,text,chat_id,thread_id,
    reply_to_message_id,connection_user_id,contact_version,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.event_id ?? null,
    input.request.id,
    input.request.contact_id,
    input.kind,
    input.dedupe_key,
    input.text,
    owner ? ownerChat : connection.private_chat_id,
    thread,
    input.reply_to_message_id ?? null,
    connection.telegram_user_id,
    version,
    at,
    at,
  );
  return db
    .prepare("SELECT * FROM payment_chat_outbox WHERE id=?")
    .get(id) as ChatDelivery;
}

export async function deliverChatMessages(
  db: Database.Database,
  options: { send?: SendPaymentMessage; now?: Date; id?: string } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  db.prepare(
    "UPDATE payment_chat_outbox SET status='uncertain',last_error_code='interrupted_send',lease_until=NULL WHERE status='sending' AND lease_until<=?",
  ).run(at);
  if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") return;
  const candidates = db
    .prepare(
      "SELECT id FROM payment_chat_outbox WHERE status='queued' AND next_attempt_at<=? AND (? IS NULL OR id=?) ORDER BY created_at,id LIMIT 20",
    )
    .all(at, options.id ?? null, options.id ?? null) as Array<{ id: string }>;
  for (const candidate of candidates) {
    if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") break;
    const row = db.transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM payment_chat_outbox WHERE id=? AND status='queued'",
        )
        .get(candidate.id) as ChatDelivery | undefined;
      if (!row) return undefined;
      const connection = row.connection_user_id
        ? getTelegramRecipient(db, row.connection_user_id)
        : undefined;
      const version = (
        db
          .prepare("SELECT version FROM contacts WHERE id=?")
          .get(row.contact_id) as { version: number }
      ).version;
      if (
        row.kind !== "owner_alert" &&
        (!connection ||
          connection.contact_id !== row.contact_id ||
          connection.private_chat_id !== row.chat_id ||
          connection.delivery_status !== "ready" ||
          version !== row.contact_version)
      ) {
        db.prepare(
          "UPDATE payment_chat_outbox SET status='cancelled',last_error_code='access_changed' WHERE id=?",
        ).run(row.id);
        return undefined;
      }
      // Do not forward owner-private material if the configured destination has changed.
      const ownerChat =
        process.env.TELEGRAM_CHAT_ID?.trim() ||
        process.env.TELEGRAM_OWNER_USER_ID?.trim();
      const ownerThread =
        process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_THREAD_ID
          ? Number(process.env.TELEGRAM_THREAD_ID)
          : null;
      if (
        row.kind === "owner_alert" &&
        (row.chat_id !== ownerChat || row.thread_id !== ownerThread)
      ) {
        db.prepare(
          "UPDATE payment_chat_outbox SET status='cancelled',last_error_code='owner_destination_changed' WHERE id=?",
        ).run(row.id);
        return undefined;
      }
      db.prepare(
        "UPDATE payment_chat_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?",
      ).run(new Date(now.getTime() + 120000).toISOString(), row.id);
      return row;
    })();
    if (!row) continue;
    let sentId: number;
    try {
      sentId = await (options.send ?? sendPaymentMessage)(
        row.chat_id,
        row.text,
        {
          thread_id: row.thread_id ?? undefined,
          reply_to_message_id: row.reply_to_message_id ?? undefined,
        },
      );
      if (!Number.isInteger(sentId))
        throw new DeliveryError("invalid_send_result", "uncertain");
    } catch (error) {
      const failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("transport_outcome_unknown", "uncertain");
      const status =
        failure.outcome === "retry" && row.attempts < 4
          ? "queued"
          : failure.outcome === "uncertain"
            ? "uncertain"
            : "failed";
      db.prepare(
        "UPDATE payment_chat_outbox SET status=?,last_error_code=?,next_attempt_at=?,lease_until=NULL WHERE id=?",
      ).run(
        status,
        failure.code,
        new Date(now.getTime() + failure.retryAfter * 1000).toISOString(),
        row.id,
      );
      continue;
    }
    // If this write fails, recovery marks the send uncertain rather than duplicating it.
    db.prepare(
      "UPDATE payment_chat_outbox SET status='sent',telegram_message_id=?,sent_at=?,lease_until=NULL,last_error_code=NULL WHERE id=?",
    ).run(sentId, at, row.id);
  }
}

export function ownerReplyRequest(
  db: Database.Database,
  chatId: string,
  threadId?: number,
  messageId?: number,
): string | undefined {
  if (messageId === undefined) return undefined;
  return (
    db
      .prepare(
        "SELECT request_id FROM payment_chat_outbox WHERE kind='owner_alert' AND status='sent' AND chat_id=? AND thread_id IS ? AND telegram_message_id=?",
      )
      .get(chatId, threadId ?? null, messageId) as
      | { request_id: string }
      | undefined
  )?.request_id;
}

export async function relayOwnerReply(
  db: Database.Database,
  requestId: string,
  message: string,
  context: OwnerContext,
  send?: SendPaymentMessage,
) {
  const owner = requireOwner(context);
  const request = db
    .prepare("SELECT * FROM payment_requests WHERE id=? AND status='sent'")
    .get(requestId) as PaymentRequest | undefined;
  if (!request) throw new Error("Unknown sent payment request");
  if (!message.trim() || message.length > 1800)
    throw new Error("Reply must contain 1-1800 characters");
  const row = queueChatMessage(db, {
    request,
    kind: "owner_relay",
    dedupe_key: `relay:${owner.source}:${owner.request_id}:${requestId}`,
    text: `Aniket replied about ${plain(request.context).slice(0, 160)}:\n\n${plain(message)}`,
  });
  if (
    row.text !==
    `Aniket replied about ${plain(request.context).slice(0, 160)}:\n\n${plain(message)}`
  )
    throw new Error(
      "A different reply for this request was already handled in this owner turn; inspect its delivery before sending another",
    );
  await deliverChatMessages(db, { send, id: row.id });
  return db
    .prepare(
      "SELECT id,status,last_error_code FROM payment_chat_outbox WHERE id=?",
    )
    .get(row.id);
}
