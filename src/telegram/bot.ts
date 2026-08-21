import TelegramBot from "node-telegram-bot-api";
import type Database from "better-sqlite3";
import { getContext, setContext, deleteContext } from "../db/queries";
import { runAgent } from "../agent/runner";
import {
  runContributorAgent,
  type ContributorAgentResult,
  type ContributorIdentity,
} from "../agent/contributor";
import {
  claimTelegramContributorInvite,
  getActiveTelegramContributor,
} from "./access";

const MESSAGE_MAP_KEY = "telegram_message_map";
const PENDING_REBALANCE_KEY = "pending_rebalance_message";

let botInstance: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (!botInstance) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
    botInstance = new TelegramBot(token);
  }
  return botInstance;
}

function getChatId(): string {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing TELEGRAM_CHAT_ID");
  return chatId;
}

function getThreadId(): number {
  const threadId = process.env.TELEGRAM_THREAD_ID;
  if (!threadId) throw new Error("Missing TELEGRAM_THREAD_ID");
  return Number(threadId);
}

export interface TelegramAccessStatus {
  webhook_secret_configured: boolean;
  owner_identity_configured: boolean;
  valid: boolean;
}

export type TelegramActor =
  | { role: "owner"; telegram_user_id: string; name: "Aniket" }
  | { role: "contributor"; telegram_user_id: string; name: string };

export function getTelegramAccessStatus(): TelegramAccessStatus {
  const ownerId = process.env.TELEGRAM_OWNER_USER_ID?.trim() ?? "";
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  return {
    webhook_secret_configured: Boolean(webhookSecret),
    owner_identity_configured: Boolean(ownerId),
    valid: Boolean(webhookSecret) && Boolean(ownerId),
  };
}

export function createBot(): TelegramBot {
  return getBot();
}

export async function sendMessage(text: string, replyToMessageId?: number): Promise<number> {
  return sendMessageToChat(getChatId(), text, {
    thread_id: getThreadId(),
    reply_to_message_id: replyToMessageId,
  });
}

export async function sendMessageToChat(
  chatId: string | number,
  text: string,
  options: { thread_id?: number; reply_to_message_id?: number } = {}
): Promise<number> {
  const message = await getBot().sendMessage(chatId, text, {
    message_thread_id: options.thread_id,
    reply_to_message_id: options.reply_to_message_id,
  });
  return message.message_id;
}

export async function sendTypingAction(): Promise<void> {
  return sendTypingActionToChat(getChatId(), getThreadId());
}

export async function sendTypingActionToChat(
  chatId: string | number,
  threadId?: number
): Promise<void> {
  try {
    await getBot().sendChatAction(chatId, "typing", { message_thread_id: threadId });
  } catch (err) {
    console.error("[telegram] failed to send typing action:", err instanceof Error ? err.message : err);
  }
}

export async function editMessage(messageId: number, newText: string): Promise<void> {
  try {
    const bot = getBot();
    const chatId = getChatId();

    await bot.editMessageText(newText, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    // Telegram rejects edits on messages older than 48h, and the original
    // message may have been deleted by the user — neither should crash the caller.
    console.error(`[telegram] failed to edit message ${messageId}:`, err instanceof Error ? err.message : err);
  }
}

export async function registerWebhook(): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[telegram] WEBHOOK_URL not set, skipping webhook registration (use ngrok for local testing)");
    return;
  }

  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    console.error(
      "[telegram] TELEGRAM_WEBHOOK_SECRET not set — refusing to register an unverifiable webhook"
    );
    return;
  }
  const accessStatus = getTelegramAccessStatus();
  if (!accessStatus.valid) {
    console.error(
      "[telegram] access control is not configured; incoming messages will fail closed until TELEGRAM_OWNER_USER_ID and TELEGRAM_WEBHOOK_SECRET are valid"
    );
  }

  try {
    const bot = getBot();
    const url = `${webhookUrl.replace(/\/$/, "")}/webhook/telegram`;
    await bot.setWebHook(url, secretToken ? { secret_token: secretToken } : undefined);
    console.log(`[telegram] webhook registered: ${url}${secretToken ? " (with secret_token)" : ""}`);
  } catch (err) {
    console.error("[telegram] failed to register webhook:", err);
  }
}

export async function flushPendingRebalanceMessage(db: Database.Database): Promise<void> {
  const row = getContext(db, PENDING_REBALANCE_KEY);
  if (!row?.value) return;

  try {
    await sendMessage(row.value);
    deleteContext(db, PENDING_REBALANCE_KEY);
    console.log("[telegram] flushed pending rebalance message from startup");
  } catch (err) {
    console.error("[telegram] failed to send pending rebalance message on startup:", err);
  }
}

// -- message <-> transaction mapping (for reply threading) --

function getMessageMap(db: Database.Database): Record<string, string> {
  const row = getContext(db, MESSAGE_MAP_KEY);
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function scopedMessageKey(chatId: string | number, messageId: number): string {
  return `${String(chatId)}:${messageId}`;
}

export function recordTransactionMessage(
  db: Database.Database,
  messageId: number,
  transactionId: string,
  chatId: string | number = getChatId()
): void {
  const map = getMessageMap(db);
  map[scopedMessageKey(chatId, messageId)] = transactionId;
  setContext(db, MESSAGE_MAP_KEY, JSON.stringify(map));
}

export function getTransactionIdForMessage(
  db: Database.Database,
  messageId: number,
  chatId: string | number = getChatId()
): string | undefined {
  const map = getMessageMap(db);
  return map[scopedMessageKey(chatId, messageId)] ?? map[String(messageId)];
}

export function getMessageIdForTransaction(db: Database.Database, transactionId: string): number | undefined {
  const map = getMessageMap(db);
  const entry = Object.entries(map).find(([, txId]) => txId === transactionId);
  if (!entry) return undefined;
  const messageId = entry[0].includes(":") ? entry[0].split(":").at(-1) : entry[0];
  return messageId ? Number(messageId) : undefined;
}

// -- incoming webhook updates --

export interface TelegramIncomingMessage {
  message_id: number;
  chat: { id: number | string; type?: "private" | "group" | "supergroup" | "channel" };
  from?: {
    id: number | string;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message_thread_id?: number;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
}

export function resolveTelegramActor(
  db: Database.Database,
  message: TelegramIncomingMessage
): TelegramActor | null {
  const senderId = message.from?.id;
  if (senderId === undefined || message.from?.is_bot) return null;
  if (!getTelegramAccessStatus().valid) return null;
  const sender = String(senderId);
  const ownerId = process.env.TELEGRAM_OWNER_USER_ID?.trim();
  if (!ownerId) return null;

  if (sender === ownerId) {
    const isDirect = message.chat.type === "private" || String(message.chat.id) === sender;
    const isConfiguredOwnerTopic =
      String(message.chat.id) === String(process.env.TELEGRAM_CHAT_ID ?? "") &&
      message.message_thread_id === Number(process.env.TELEGRAM_THREAD_ID);
    return isDirect || isConfiguredOwnerTopic
      ? { role: "owner", telegram_user_id: sender, name: "Aniket" }
      : null;
  }

  const contributor = getActiveTelegramContributor(db, sender);
  if (contributor)
    return {
      role: "contributor",
      telegram_user_id: sender,
      name: contributor.counterparty_name,
    };
  return null;
}

interface TelegramHandlerDependencies {
  runOwnerAgent?: typeof runAgent;
  runContributorAgent?: typeof runContributorAgent;
  sendToIncomingChat?: typeof sendMessageToChat;
  sendOwnerMessage?: typeof sendMessage;
  sendTyping?: typeof sendTypingActionToChat;
}

function contributorAuditMessage(receipt: ContributorAgentResult["recorded_purchases"][number]): string {
  const classification = receipt.flex_classification
    ? ` · ${receipt.flex_classification}`
    : " · flex unclassified";
  return [
    `👤 ${receipt.reporter} recorded a payment made for you`,
    `₹${receipt.gross_amount_inr.toLocaleString("en-IN")} · ${receipt.label}`,
    `${receipt.occurred_at.slice(0, 10)} · your share ₹${receipt.owner_share_inr.toLocaleString("en-IN")}`,
    `${receipt.treatment}${classification}`,
    `Reply with corrections if anything is off.`,
  ].join("\n");
}

export function parseTelegramContributorClaim(text: string): string | null {
  const match = text
    .trim()
    .match(/^\/(?:join|start)(?:@[A-Za-z0-9_]+)?(?:\s+)(?:plutus_)?([A-Za-z0-9_-]{24,})$/i);
  return match?.[1] ?? null;
}

export async function handleTelegramUpdate(
  db: Database.Database,
  update: TelegramUpdate,
  dependencies: TelegramHandlerDependencies = {}
): Promise<void> {
  const message = update.message;
  if (!message) return;
  if (!message.text) return;

  const claimToken = parseTelegramContributorClaim(message.text);
  if (claimToken) {
    const senderId = message.from?.id;
    const sendIncoming = dependencies.sendToIncomingChat ?? sendMessageToChat;
    if (senderId === undefined || message.from?.is_bot || !getTelegramAccessStatus().valid) return;
    try {
      const claim = claimTelegramContributorInvite(db, {
        claim_token: claimToken,
        telegram_user_id: String(senderId),
        owner_telegram_user_id: process.env.TELEGRAM_OWNER_USER_ID as string,
      });
      await sendIncoming(
        message.chat.id,
        `Access confirmed as ${claim.contributor.counterparty_name}. I can help record what you pay for Aniket and show only your shared tab with him.`,
        { thread_id: message.message_thread_id, reply_to_message_id: message.message_id }
      );
      if (!claim.was_existing) {
        await (dependencies.sendOwnerMessage ?? sendMessage)(
          `🔐 ${claim.contributor.counterparty_name} accepted their Plutus invitation.\nThey can now record payments for you and view only your bilateral tab.`
        );
      }
    } catch {
      await sendIncoming(
        message.chat.id,
        "That invitation is invalid or expired. Ask Aniket for a new one.",
        { thread_id: message.message_thread_id, reply_to_message_id: message.message_id }
      );
    }
    return;
  }

  const actor = resolveTelegramActor(db, message);
  if (!actor) {
    console.warn(
      `[telegram] ignored unauthorized message update_id=${update.update_id} sender=${String(message.from?.id ?? "missing")}`
    );
    return;
  }

  const replyToId = message.reply_to_message?.message_id;
  const linkedTransactionId =
    actor.role === "owner" && replyToId
      ? getTransactionIdForMessage(db, replyToId, message.chat.id)
      : undefined;

  if (linkedTransactionId) {
    console.log(`[telegram] authorized owner reply linked to transaction ${linkedTransactionId}`);
  } else {
    console.log(
      `[telegram] authorized ${actor.role} message update_id=${update.update_id} chat=${String(message.chat.id)}`
    );
  }

  // Telegram's "typing" indicator only lasts ~5s, so refresh it periodically
  // while the agent (o3 can take 10-30s) is still working.
  const sendTyping = dependencies.sendTyping ?? sendTypingActionToChat;
  void sendTyping(message.chat.id, message.message_thread_id);
  const typingInterval = setInterval(
    () => void sendTyping(message.chat.id, message.message_thread_id),
    4000
  );

  try {
    let reply: string;
    if (actor.role === "owner") {
      reply = await (dependencies.runOwnerAgent ?? runAgent)(db, {
        user_message: message.text,
        interface: "telegram",
        replied_to_transaction_id: linkedTransactionId,
      });
    } else {
      const contributorIdentity: ContributorIdentity = {
        telegram_user_id: actor.telegram_user_id,
        name: actor.name,
      };
      const result = await (dependencies.runContributorAgent ?? runContributorAgent)(db, {
        identity: contributorIdentity,
        conversation_id: String(message.chat.id),
        message_id: message.message_id,
        user_message: message.text,
      });
      reply = result.text;
      for (const receipt of result.recorded_purchases) {
        await (dependencies.sendOwnerMessage ?? sendMessage)(contributorAuditMessage(receipt));
      }
    }
    await (dependencies.sendToIncomingChat ?? sendMessageToChat)(message.chat.id, reply, {
      thread_id: message.message_thread_id,
      reply_to_message_id: message.message_id,
    });
  } catch (err) {
    console.error("[telegram] agent run failed:", err);
    await (dependencies.sendToIncomingChat ?? sendMessageToChat)(
      message.chat.id,
      "Something went wrong on my end — try again in a bit.",
      {
        thread_id: message.message_thread_id,
        reply_to_message_id: message.message_id,
      }
    );
  } finally {
    clearInterval(typingInterval);
  }
}
