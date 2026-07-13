import TelegramBot from "node-telegram-bot-api";
import type Database from "better-sqlite3";
import { getContext, setContext, deleteContext } from "../db/queries";
import { runAgent } from "../agent/runner";

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

export function createBot(): TelegramBot {
  return getBot();
}

export async function sendMessage(text: string, replyToMessageId?: number): Promise<number> {
  const bot = getBot();
  const chatId = getChatId();
  const threadId = getThreadId();

  const message = await bot.sendMessage(chatId, text, {
    message_thread_id: threadId,
    reply_to_message_id: replyToMessageId,
  });

  return message.message_id;
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

  try {
    const bot = getBot();
    const url = `${webhookUrl.replace(/\/$/, "")}/webhook/telegram`;
    await bot.setWebHook(url);
    console.log(`[telegram] webhook registered: ${url}`);
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

export function recordTransactionMessage(db: Database.Database, messageId: number, transactionId: string): void {
  const map = getMessageMap(db);
  map[String(messageId)] = transactionId;
  setContext(db, MESSAGE_MAP_KEY, JSON.stringify(map));
}

export function getTransactionIdForMessage(db: Database.Database, messageId: number): string | undefined {
  return getMessageMap(db)[String(messageId)];
}

export function getMessageIdForTransaction(db: Database.Database, transactionId: string): number | undefined {
  const map = getMessageMap(db);
  const entry = Object.entries(map).find(([, txId]) => txId === transactionId);
  return entry ? Number(entry[0]) : undefined;
}

// -- incoming webhook updates --

export interface TelegramIncomingMessage {
  message_id: number;
  chat: { id: number | string };
  message_thread_id?: number;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
}

export async function handleTelegramUpdate(db: Database.Database, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = getChatId();
  const threadId = getThreadId();

  if (String(message.chat.id) !== String(chatId) || message.message_thread_id !== threadId) {
    return;
  }

  if (!message.text) return;

  const replyToId = message.reply_to_message?.message_id;
  const linkedTransactionId = replyToId ? getTransactionIdForMessage(db, replyToId) : undefined;

  if (linkedTransactionId) {
    console.log(`[telegram] incoming reply linked to transaction ${linkedTransactionId}: "${message.text}"`);
  } else {
    console.log(`[telegram] incoming general message: "${message.text}"`);
  }

  try {
    const reply = await runAgent(db, {
      user_message: message.text,
      interface: "telegram",
      replied_to_transaction_id: linkedTransactionId,
    });
    await sendMessage(reply, message.message_id);
  } catch (err) {
    console.error("[telegram] agent run failed:", err);
    await sendMessage("Something went wrong on my end — try again in a bit.", message.message_id);
  }
}
