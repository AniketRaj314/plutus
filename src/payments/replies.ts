import type Database from "better-sqlite3";
import { getTelegramRecipient, setRecipientDelivery } from "../telegram/access";
import type { PaymentRequest } from "./requests";

// The recipient surface never loads the owner or contributor conversation history.
// A reply is evidence for review, never a receipt or a ledger write.
export function handleRecipientMessage(
  db: Database.Database,
  input: {
    user_id: string;
    chat_id: string;
    message_id: number;
    text: string;
    reply_to_message_id?: number;
  },
): { text: string; duplicate?: boolean } {
  const person = getTelegramRecipient(db, input.user_id);
  if (!person || input.chat_id !== person.private_chat_id)
    throw new Error("Private recipient connection required");
  const command = input.text.trim().toLowerCase();
  if (command === "/stop" || command === "/stop_requests") {
    setRecipientDelivery(db, input.user_id, "opted_out");
    return {
      text: "Payment requests are paused. Your shared financial records are unchanged. Use /resume_requests if you want to receive requests again.",
    };
  }
  if (command === "/resume_requests") {
    setRecipientDelivery(db, input.user_id, "ready");
    return {
      text: "You can receive new payment requests from Aniket again. Previously paused requests will not be sent automatically.",
    };
  }
  const row =
    input.reply_to_message_id === undefined
      ? undefined
      : (db
          .prepare(
            "SELECT * FROM payment_requests WHERE contact_id=? AND telegram_message_id=? AND status='sent'",
          )
          .get(person.contact_id, input.reply_to_message_id) as
          | PaymentRequest
          | undefined);
  if (row) {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO payment_replies(request_id,telegram_user_id,message_id,text,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        row.id,
        input.user_id,
        input.message_id,
        input.text.slice(0, 4000),
        new Date().toISOString(),
      );
    return {
      duplicate: !result.changes,
      text: "Thanks! Your reply is saved for Aniket to review. A payment report is only marked received after verification.",
    };
  }
  const requests = db
    .prepare(
      "SELECT message FROM payment_requests WHERE contact_id=? AND status='sent' ORDER BY sent_at DESC LIMIT 3",
    )
    .all(person.contact_id) as Array<{ message: string }>;
  return {
    text: requests.length
      ? "Please reply directly to the payment request you mean so I can attach your question or payment update. These are previously sent requests, not a fresh balance calculation.\n\n" +
        requests.map((r) => r.message).join("\n\n")
      : "You're connected to Violet for payment requests from Aniket. There are no requests sent to you yet. Use /stop_requests to pause them.",
  };
}

export function isPaymentReply(
  db: Database.Database,
  contactId: string,
  messageId?: number,
): boolean {
  return (
    messageId !== undefined &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM payment_requests WHERE contact_id=? AND telegram_message_id=? AND status='sent'",
        )
        .get(contactId, messageId),
    )
  );
}
