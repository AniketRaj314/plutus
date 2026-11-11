import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentImageInput } from "../agent/image-input";
import { getTelegramRecipient } from "../telegram/access";
import {
  DeliveryError,
  sendPaymentMessage,
  telegramMessageResult,
  type SendPaymentMessage,
} from "./delivery";
import type { SplitDraft } from "./split-drafts";

export interface SplitDelivery {
  id: string;
  contact_id: string;
  user_id: string;
  contact_version: number;
  draft_id: string | null;
  revision: number | null;
  audience: "owner" | "recipient";
  chat_id: string;
  thread_id: number | null;
  reply_to_message_id: number | null;
  text: string;
  media: string | null;
  attempts: number;
}
export function ownerDestination() {
  return {
    chat:
      process.env.TELEGRAM_CHAT_ID?.trim() ||
      process.env.TELEGRAM_OWNER_USER_ID?.trim(),
    thread:
      process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_THREAD_ID
        ? Number(process.env.TELEGRAM_THREAD_ID)
        : null,
  };
}
export function queueSplitMessage(
  db: Database.Database,
  input: {
    userId: string;
    audience: "owner" | "recipient";
    key: string;
    text: string;
    draft?: SplitDraft;
    replyTo?: number;
    media?: AgentImageInput;
  },
): void {
  if (!input.media && input.text.length > 3000) {
    for (let i = 0; i < input.text.length; i += 3000)
      queueSplitMessage(db, {
        ...input,
        key: `${input.key}:part:${i}`,
        text: input.text.slice(i, i + 3000),
      });
    return;
  }
  const person = getTelegramRecipient(db, input.userId);
  if (!person) throw new Error("Connection no longer active");
  const version = (
    db
      .prepare("SELECT version FROM contacts WHERE id=?")
      .get(person.contact_id) as { version: number }
  ).version;
  const owner = ownerDestination();
  if (input.audience === "owner" && !owner.chat)
    throw new Error("Owner destination not configured");
  const at = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO split_outbox(id,contact_id,user_id,contact_version,draft_id,revision,dedupe_key,
    audience,chat_id,thread_id,reply_to_message_id,text,media,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    person.contact_id,
    input.userId,
    version,
    input.draft?.id ?? null,
    input.draft?.revision ?? null,
    input.key,
    input.audience,
    input.audience === "owner" ? owner.chat : person.private_chat_id,
    input.audience === "owner" ? owner.thread : null,
    input.replyTo ?? null,
    input.text,
    input.media ? JSON.stringify(input.media) : null,
    at,
    at,
  );
}
export type SendSplitMedia = (
  row: SplitDelivery,
  media: AgentImageInput,
) => Promise<number>;
const sendMedia: SendSplitMedia = async (row, media) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new DeliveryError("bot_not_configured", "failed");
  const match = media.data_url.match(
    /^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!match) throw new DeliveryError("invalid_receipt", "failed");
  const bytes = Buffer.from(match[2], "base64");
  const form = new FormData();
  form.set("chat_id", row.chat_id);
  form.set(
    "document",
    new Blob([new Uint8Array(bytes)], { type: match[1] }),
    `receipt.${match[1] === "application/pdf" ? "pdf" : match[1].split("/")[1]}`,
  );
  form.set("caption", row.text.slice(0, 900));
  if (row.thread_id !== null)
    form.set("message_thread_id", String(row.thread_id));
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/bot${token}/sendDocument`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new DeliveryError("receipt_send_unknown", "uncertain");
  }
  return telegramMessageResult(response);
};
export async function deliverSplitMessages(
  db: Database.Database,
  options: {
    send?: SendPaymentMessage;
    sendMedia?: SendSplitMedia;
    now?: Date;
  } = {},
) {
  const now = options.now ?? new Date(),
    at = now.toISOString();
  db.prepare(
    "UPDATE split_outbox SET status='uncertain',error_code='interrupted_send' WHERE status='sending' AND lease_until<=?",
  ).run(at);
  if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") return;
  const rows = db
    .prepare(
      "SELECT id FROM split_outbox WHERE status='queued' AND next_attempt_at<=? ORDER BY rowid LIMIT 30",
    )
    .all(at) as Array<{ id: string }>;
  for (const candidate of rows) {
    if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") break;
    const row = db.transaction(() => {
      const r = db
        .prepare("SELECT * FROM split_outbox WHERE id=? AND status='queued'")
        .get(candidate.id) as SplitDelivery | undefined;
      if (!r) return;
      const person = getTelegramRecipient(db, r.user_id);
      const contact = db
        .prepare("SELECT version FROM contacts WHERE id=?")
        .get(r.contact_id) as { version: number };
      const draft = r.draft_id
        ? (db
            .prepare("SELECT revision FROM split_drafts WHERE id=?")
            .get(r.draft_id) as { revision: number })
        : null;
      const owner = ownerDestination();
      if (
        !person ||
        person.contact_id !== r.contact_id ||
        person.delivery_status !== "ready" ||
        contact.version !== r.contact_version ||
        (draft && draft.revision !== r.revision) ||
        (r.audience === "owner"
          ? owner.chat !== r.chat_id || owner.thread !== r.thread_id
          : person.private_chat_id !== r.chat_id)
      ) {
        db.prepare(
          "UPDATE split_outbox SET status='cancelled',error_code='scope_changed' WHERE id=?",
        ).run(r.id);
        return;
      }
      db.prepare(
        "UPDATE split_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?",
      ).run(new Date(now.getTime() + 120000).toISOString(), r.id);
      return r;
    })();
    if (!row) continue;
    try {
      const messageId = row.media
        ? await (options.sendMedia ?? sendMedia)(row, JSON.parse(row.media))
        : await (options.send ?? sendPaymentMessage)(row.chat_id, row.text, {
            thread_id: row.thread_id ?? undefined,
            reply_to_message_id: row.reply_to_message_id ?? undefined,
          });
      if (!Number.isInteger(messageId))
        throw new DeliveryError("invalid_result", "uncertain");
      db.prepare(
        "UPDATE split_outbox SET status='sent',telegram_message_id=?,lease_until=NULL,error_code=NULL WHERE id=?",
      ).run(messageId, row.id);
    } catch (error) {
      const e =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("send_unknown", "uncertain");
      db.prepare(
        "UPDATE split_outbox SET status=?,error_code=?,lease_until=NULL,next_attempt_at=? WHERE id=?",
      ).run(
        e.outcome === "retry" && row.attempts < 4
          ? "queued"
          : e.outcome === "uncertain"
            ? "uncertain"
            : "failed",
        e.code,
        new Date(now.getTime() + e.retryAfter * 1000).toISOString(),
        row.id,
      );
    }
  }
}
export function ownerSplitReference(
  db: Database.Database,
  chat: string,
  thread?: number,
  message?: number,
) {
  if (message === undefined) return undefined;
  return db
    .prepare(
      "SELECT draft_id,revision FROM split_outbox WHERE audience='owner' AND status='sent' AND chat_id=? AND thread_id IS ? AND telegram_message_id=?",
    )
    .get(chat, thread ?? null, message) as
    | { draft_id: string; revision: number }
    | undefined;
}
