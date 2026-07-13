import type { gmail_v1 } from "googleapis";
import { newId } from "../../db/schema";
import { parseIdfcCreditCard } from "./idfc-cc";
import { parseBobCard } from "./bobcard";
import { parseAmex } from "./amex";
import { parseIdfcUpi } from "./idfc-upi";
import type { EmailContent, ParsedTransaction } from "./types";

export type { ParsedTransaction, EmailContent, TransactionSource } from "./types";
export { parseIdfcCreditCard } from "./idfc-cc";
export { parseBobCard } from "./bobcard";
export { parseAmex } from "./amex";
export { parseIdfcUpi } from "./idfc-upi";

export function parseGmailMessage(message: gmail_v1.Schema$Message): ParsedTransaction | null {
  const messageId = message.id;
  if (!messageId) return null;

  const headers = message.payload?.headers ?? [];
  const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
  const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
  const body = extractBody(message.payload);
  const htmlBody = extractRawHtml(message.payload);

  const email: EmailContent = { from, subject, body, htmlBody };
  const fromLower = from.toLowerCase();

  const result = fromLower.includes("noreply@idfcfirstbank.com")
    ? subject.includes("Credit Card") || subject.includes("Transaction reversal")
      ? parseIdfcCreditCard(email)
      : parseIdfcUpi(email)
    : fromLower.includes("no-reply@getonecard.app")
    ? parseBobCard(email)
    : fromLower.includes("americanexpress.com")
    ? parseAmex(email)
    : null;

  if (!result) return null;

  return {
    id: newId(),
    raw_email_id: messageId,
    ...result,
  };
}

function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";

  const plain = findPart(payload, "text/plain");
  if (plain) {
    const decoded = decodeBase64Url(plain).trim();
    if (decoded && decoded.toLowerCase() !== "null") return decoded;
  }

  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBase64Url(html));

  return "";
}

function extractRawHtml(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  const html = findPart(payload, "text/html");
  return html ? decodeBase64Url(html) : "";
}

function findPart(part: gmail_v1.Schema$MessagePart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
