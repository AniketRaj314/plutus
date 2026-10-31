import type Database from "better-sqlite3";
import { getTelegramRecipient, setRecipientDelivery } from "../telegram/access";
import type { PaymentRequest } from "./requests";
import { plain } from "./messages";
import {
  answerRecipient,
  recipientPacket,
  type AnswerRecipient,
  type RecipientAnswer,
} from "./recipient-agent";
import { deliverChatMessages, queueChatMessage } from "./chat-delivery";
import type { SendPaymentMessage } from "./delivery";

interface RecipientInput {
  user_id: string;
  chat_id: string;
  message_id: number;
  text: string;
  reply_to_message_id?: number;
}
interface Event {
  id: number;
  request_id: string;
  contact_id: string;
  telegram_user_id: string;
  chat_id: string;
  message_id: number;
  text: string;
  response: string | null;
  intent: RecipientAnswer["intent"] | null;
  attempts: number;
}

export function activePaymentConversation(
  db: Database.Database,
  contactId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM payment_chat_sessions WHERE contact_id=? AND updated_at>?",
      )
      .get(contactId, new Date(Date.now() - 86400000).toISOString()),
  );
}

// Inbound acceptance is synchronous and durable. AI and Telegram delivery are handled separately.
export function handleRecipientMessage(
  db: Database.Database,
  input: RecipientInput,
): { text: string; duplicate?: boolean; event_id?: number } {
  const person = getTelegramRecipient(db, input.user_id);
  if (!person || input.chat_id !== person.private_chat_id)
    throw new Error("Private recipient connection required");
  const existing = db
    .prepare(
      "SELECT id FROM payment_chat_events WHERE telegram_user_id=? AND message_id=?",
    )
    .get(input.user_id, input.message_id) as { id: number } | undefined;
  if (existing) return { text: "", duplicate: true, event_id: existing.id };
  const command = input.text.trim().toLowerCase();
  if (["/stop", "/stop_requests", "/resume_requests"].includes(command)) {
    setRecipientDelivery(
      db,
      input.user_id,
      command === "/resume_requests" ? "ready" : "opted_out",
    );
    db.prepare("DELETE FROM payment_chat_sessions WHERE contact_id=?").run(
      person.contact_id,
    );
    db.prepare(
      "UPDATE payment_chat_outbox SET status='cancelled',last_error_code='preference_changed' WHERE contact_id=? AND kind!='owner_alert' AND status='queued'",
    ).run(person.contact_id);
    return {
      text:
        command === "/resume_requests"
          ? "You can receive requests again. Previously paused messages will not be sent automatically."
          : "Payment requests are paused. Your shared financial records are unchanged. Use /resume_requests to resume.",
    };
  }
  if (person.delivery_status !== "ready")
    return {
      text: "Payment messages are paused. Use /resume_requests to chat about your split again.",
    };
  const requests = db
    .prepare(
      "SELECT * FROM payment_requests WHERE contact_id=? AND status='sent' ORDER BY sent_at DESC,id LIMIT 30",
    )
    .all(person.contact_id) as PaymentRequest[];
  let row: PaymentRequest | undefined;
  if (input.reply_to_message_id !== undefined) {
    row = requests.find(
      (r) => r.telegram_message_id === input.reply_to_message_id,
    );
    if (!row) {
      const linked = db
        .prepare(
          "SELECT request_id FROM payment_chat_outbox WHERE contact_id=? AND chat_id=? AND kind!='owner_alert' AND status='sent' AND telegram_message_id=?",
        )
        .get(person.contact_id, input.chat_id, input.reply_to_message_id) as
        | { request_id: string }
        | undefined;
      row = requests.find((r) => r.id === linked?.request_id);
    }
    if (!row) {
      const linkedQr = db
        .prepare(
          `SELECT q.request_id FROM payment_request_qr q JOIN payment_requests p ON p.id=q.request_id
        WHERE p.contact_id=? AND q.status='sent' AND q.telegram_message_id=?`,
        )
        .get(person.contact_id, input.reply_to_message_id) as
        | { request_id: string }
        | undefined;
      row = requests.find((r) => r.id === linkedQr?.request_id);
    }
  }
  const session = db
    .prepare("SELECT * FROM payment_chat_sessions WHERE contact_id=?")
    .get(person.contact_id) as
    | {
        request_id: string | null;
        updated_at: string;
        selection_ids: string | null;
        pending_text: string | null;
      }
    | undefined;
  const selecting =
    session?.request_id === null &&
    activePaymentConversation(db, person.contact_id);
  const selectionIds: string[] = selecting
    ? JSON.parse(session?.selection_ids ?? "[]")
    : [];
  if (!row && selecting && /^\d+$/.test(command))
    row = requests.find((r) => r.id === selectionIds[Number(command) - 1]);
  const newerRequest = requests.some(
    (r) =>
      r.id !== session?.request_id &&
      r.sent_at &&
      session &&
      r.sent_at > session.updated_at,
  );
  if (
    !row &&
    !newerRequest &&
    input.reply_to_message_id === undefined &&
    activePaymentConversation(db, person.contact_id)
  )
    row = requests.find((r) => r.id === session?.request_id);
  if (!row && requests.length === 1 && input.reply_to_message_id === undefined)
    row = requests[0];
  if (command === "/splits" || command === "/start") row = undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO payment_chat_sessions(contact_id,request_id,updated_at,selection_ids,pending_text) VALUES (?,NULL,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET request_id=NULL,updated_at=excluded.updated_at,selection_ids=excluded.selection_ids,pending_text=excluded.pending_text",
    ).run(
      person.contact_id,
      new Date().toISOString(),
      JSON.stringify(requests.map((r) => r.id)),
      command.startsWith("/") ? null : input.text.slice(0, 4000),
    );
    return {
      text: requests.length
        ? "Which split do you mean? Reply with its number:\n" +
          requests
            .map(
              (r, i) =>
                `${i + 1}. ${plain(r.context).slice(0, 100)} (${r.sent_at?.slice(0, 10) ?? "sent earlier"})`,
            )
            .join("\n")
        : "You're connected to Violet. There are no requests sent to you yet. Aniket can send one when a split is ready.",
    };
  }
  const at = new Date().toISOString();
  const eventId = db.transaction(() => {
    db.prepare(
      "INSERT INTO payment_chat_sessions(contact_id,request_id,updated_at) VALUES (?,?,?) ON CONFLICT(contact_id) DO UPDATE SET request_id=excluded.request_id,updated_at=excluded.updated_at",
    ).run(person.contact_id, row!.id, at);
    db.prepare(
      "INSERT OR IGNORE INTO payment_replies(request_id,telegram_user_id,message_id,text,created_at) VALUES (?,?,?,?,?)",
    ).run(
      row!.id,
      input.user_id,
      input.message_id,
      input.text.slice(0, 4000),
      at,
    );
    return Number(
      db
        .prepare(
          "INSERT INTO payment_chat_events(contact_id,request_id,telegram_user_id,chat_id,message_id,text,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          person.contact_id,
          row!.id,
          input.user_id,
          input.chat_id,
          input.message_id,
          selecting && /^\d+$/.test(command)
            ? (session?.pending_text ?? "Let's talk about this split.")
            : input.text.slice(0, 4000),
          at,
        ).lastInsertRowid,
    );
  })();
  return { text: "", duplicate: false, event_id: eventId };
}

export function isPaymentReply(
  db: Database.Database,
  contactId: string,
  messageId?: number,
): boolean {
  if (messageId === undefined) return false;
  if (
    db
      .prepare(
        `SELECT 1 FROM payment_request_qr q JOIN payment_requests p ON p.id=q.request_id
    WHERE p.contact_id=? AND q.status='sent' AND q.telegram_message_id=?`,
      )
      .get(contactId, messageId)
  )
    return true;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM payment_requests WHERE contact_id=? AND telegram_message_id=? AND status='sent'",
      )
      .get(contactId, messageId) ||
      db
        .prepare(
          "SELECT 1 FROM payment_chat_outbox WHERE contact_id=? AND kind!='owner_alert' AND telegram_message_id=? AND status='sent'",
        )
        .get(contactId, messageId),
  );
}

export async function processRecipientConversations(
  db: Database.Database,
  options: {
    answer?: AnswerRecipient;
    send?: SendPaymentMessage;
    now?: Date;
  } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  db.prepare(
    "UPDATE payment_chat_events SET status='pending',lease_until=NULL WHERE status='processing' AND lease_until<=?",
  ).run(at);
  if (process.env.PAYMENT_REQUEST_DELIVERY_ENABLED !== "true") return;
  const candidates = db
    .prepare(
      "SELECT id FROM payment_chat_events WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT 20",
    )
    .all(at) as Array<{ id: number }>;
  for (const candidate of candidates) {
    const event = db.transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM payment_chat_events WHERE id=? AND status='pending'",
        )
        .get(candidate.id) as Event | undefined;
      if (
        !row ||
        db
          .prepare(
            "SELECT 1 FROM payment_chat_events WHERE contact_id=? AND id<? AND status IN ('pending','processing')",
          )
          .get(row.contact_id, row.id)
      )
        return undefined;
      const connection = getTelegramRecipient(db, row.telegram_user_id);
      if (
        !connection ||
        connection.contact_id !== row.contact_id ||
        connection.private_chat_id !== row.chat_id ||
        connection.delivery_status !== "ready"
      ) {
        db.prepare(
          "UPDATE payment_chat_events SET status='cancelled' WHERE id=?",
        ).run(row.id);
        return undefined;
      }
      db.prepare(
        "UPDATE payment_chat_events SET status='processing',attempts=attempts+1,lease_until=? WHERE id=?",
      ).run(new Date(now.getTime() + 120000).toISOString(), row.id);
      return row;
    })();
    if (!event) continue;
    const request = db
      .prepare("SELECT * FROM payment_requests WHERE id=?")
      .get(event.request_id) as PaymentRequest;
    try {
      const packet = recipientPacket(db, request, event.text, event.id);
      const version = (
        db
          .prepare("SELECT version FROM contacts WHERE id=?")
          .get(event.contact_id) as { version: number }
      ).version;
      let answer: RecipientAnswer;
      try {
        answer = await (options.answer ?? answerRecipient)(packet);
      } catch {
        answer = {
          intent: "question",
          text: "I couldn't reliably answer that from the bill details just now.",
        };
      }
      const connection = getTelegramRecipient(db, event.telegram_user_id);
      if (
        !connection ||
        connection.contact_id !== event.contact_id ||
        connection.private_chat_id !== event.chat_id ||
        connection.delivery_status !== "ready" ||
        (
          db
            .prepare("SELECT version FROM contacts WHERE id=?")
            .get(event.contact_id) as { version: number }
        ).version !== version
      ) {
        db.prepare(
          "UPDATE payment_chat_events SET status='cancelled' WHERE id=?",
        ).run(event.id);
        continue;
      }
      if (
        JSON.stringify(recipientPacket(db, request, event.text, event.id)) !==
        JSON.stringify(packet)
      )
        answer = {
          intent: "question",
          text: "The split details have changed, so I need Aniket to confirm the explanation.",
        };
      if (packet.request.details_changed_since_send && answer.intent === "none")
        answer = {
          intent: "question",
          text: "The split details have changed since that request. The earlier amount needs Aniket's review.",
        };
      const claimsAction =
        /(?:notified|forwarded|passed (?:it|that|this|your)|sent (?:it|that|this|your)|(?:will|I'll) (?:tell|ask|check with|notify|let Aniket)|marked (?:it |as )?(?:paid|received)|(?:updated|changed|settled|cleared) (?:the |your )?(?:balance|split|payment|debt))/i;
      if (answer.intent === "none" && claimsAction.test(answer.text))
        answer = { intent: "question", text: "I need Aniket's input on that." };
      let response = answer.text.replace(/\u2014/g, ", ");
      if (answer.intent !== "none") {
        const opening =
          answer.intent === "payment_claim"
            ? "Thanks for the payment update. It still needs verification."
            : answer.intent === "dispute"
              ? "Thanks for flagging that. I'll keep your concern attached to this split."
              : answer.intent === "relay"
                ? "Got it, your message is attached to this split."
                : "I need Aniket's input to answer that accurately.";
        const alert = queueChatMessage(db, {
          request,
          event_id: event.id,
          kind: "owner_alert",
          dedupe_key: `alert:${event.id}`,
          text: `${plain(connection.counterparty_name)} ${answer.intent === "payment_claim" ? "reported a payment" : answer.intent === "dispute" ? "raised a split concern" : "has a message for you"}\n${plain(request.context).slice(0, 200)}\nRequest: ${request.id}\n\nThey said: ${plain(event.text).slice(0, 2000)}\n\nReply here to discuss it with Violet. To send your response, say "Tell them: ...". This does not change the ledger.`,
        });
        await deliverChatMessages(db, { send: options.send, id: alert.id });
        const delivery = db
          .prepare("SELECT status FROM payment_chat_outbox WHERE id=?")
          .get(alert.id) as { status: string };
        const conversational = claimsAction.test(answer.text)
          ? opening
          : answer.text;
        response = `${conversational}\n\n${delivery.status === "sent" ? "I've notified Aniket. I'll pass along his reply here when he responds." : delivery.status === "queued" ? "Your message is queued for Aniket. I haven't confirmed delivery yet." : "Your message is saved, but I couldn't confirm notification delivery to Aniket. You may want to contact him directly."}${answer.intent === "payment_claim" ? "\nPayment remains unverified until Aniket checks it." : ""}`;
      }
      db.transaction(() => {
        queueChatMessage(db, {
          request,
          event_id: event.id,
          kind: "recipient_reply",
          dedupe_key: `response:${event.id}`,
          text: response,
          reply_to_message_id: event.message_id,
        });
        db.prepare(
          "UPDATE payment_chat_events SET status='done',response=?,intent=?,review_status=?,lease_until=NULL WHERE id=?",
        ).run(
          response,
          answer.intent,
          answer.intent === "none" ? "none" : "pending_owner",
          event.id,
        );
      })();
      await deliverChatMessages(db, { send: options.send });
    } catch {
      db.prepare(
        "UPDATE payment_chat_events SET status=?,lease_until=NULL,next_attempt_at=? WHERE id=? AND status='processing'",
      ).run(
        event.attempts >= 4 ? "failed" : "pending",
        new Date(now.getTime() + 60000).toISOString(),
        event.id,
      );
    }
  }
}
