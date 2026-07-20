import type Database from "better-sqlite3";
import type { gmail_v1 } from "googleapis";
import { getContext } from "../db/queries";
import { getGmailClient } from "./auth";
import { getGmailReceivedAt, parseGmailMessage } from "./parsers";
import { isLikelyTransactionAlert } from "./poller";

const DIAGNOSTIC_SENDERS = {
  amex: ["AmericanExpress@welcome.americanexpress.com"],
  bobcard: ["no-reply@getonecard.app"],
  idfc: ["noreply@idfcfirstbank.com"],
  icici: ["credit_cards@icici.bank.in"],
} as const;

const PROVIDERS = ["all", "amex", "bobcard", "idfc", "icici"] as const;
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_WINDOW_DAYS = 62;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

type DiagnosticProvider = (typeof PROVIDERS)[number];
type ParserStatus = "matched" | "unparseable" | "ignored";
type StorageStatus = "ingested" | "missing" | "retry_pending" | "ignored" | "processed_without_raw";

export interface SearchTransactionEmailsArgs {
  provider?: DiagnosticProvider;
  start_date?: string;
  end_date?: string;
  limit?: number;
}

interface SearchTransactionEmailsOptions {
  gmail?: gmail_v1.Gmail;
  now?: Date;
}

interface ParsedTransactionSummary {
  source: string;
  amount: number;
  currency: string;
  amount_inr: number | null;
  merchant_raw: string | null;
  occurred_at: string;
  card_last4: string;
  direction: string;
  is_reversal: boolean;
  is_international: boolean;
}

export interface TransactionEmailDiagnostic {
  message_id: string;
  thread_id: string | null;
  sender: string;
  subject: string;
  received_at: string | null;
  snippet: string;
  parser_status: ParserStatus;
  storage_status: StorageStatus;
  raw_transaction_id: string | null;
  parsed_transaction: ParsedTransactionSummary | null;
}

export interface SearchTransactionEmailsResult {
  status: "ok";
  provider: DiagnosticProvider;
  start_date: string;
  end_date: string;
  count: number;
  messages: TransactionEmailDiagnostic[];
  poller: {
    last_successful_poll_at: string | null;
    sync_status: "healthy" | "failed" | "unknown";
  };
  privacy: string;
}

function parseDateOnly(value: string, field: string): Date {
  if (typeof value !== "string") throw new Error(`${field} must use YYYY-MM-DD`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${field} is not a valid calendar date`);
  }
  return parsed;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function currentIstDate(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function dateOnlyToIstEpochSeconds(date: Date): number {
  return Math.floor((date.getTime() - IST_OFFSET_MS) / 1000);
}

function parseStringSet(db: Database.Database, key: string): Set<string> {
  const value = getContext(db, key)?.value;
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function getPollerState(db: Database.Database): SearchTransactionEmailsResult["poller"] {
  const lastPollSeconds = Number(getContext(db, "last_gmail_poll")?.value);
  let syncStatus: "healthy" | "failed" | "unknown" = "unknown";
  const syncValue = getContext(db, "gmail_sync_alert_state")?.value;
  if (syncValue) {
    try {
      const parsed = JSON.parse(syncValue) as { status?: unknown };
      if (parsed.status === "healthy" || parsed.status === "failed") syncStatus = parsed.status;
    } catch {
      syncStatus = "unknown";
    }
  }
  return {
    last_successful_poll_at:
      Number.isFinite(lastPollSeconds) && lastPollSeconds > 0
        ? new Date(lastPollSeconds * 1000).toISOString()
        : null,
    sync_status: syncStatus,
  };
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  return (
    message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function resolveSenders(provider: DiagnosticProvider): string[] {
  if (provider === "all") return Object.values(DIAGNOSTIC_SENDERS).flat();
  const selected: Exclude<DiagnosticProvider, "all"> = provider;
  return [...DIAGNOSTIC_SENDERS[selected]];
}

function buildParsedSummary(
  parsed: NonNullable<ReturnType<typeof parseGmailMessage>>
): ParsedTransactionSummary {
  return {
    source: parsed.source,
    amount: parsed.amount,
    currency: parsed.currency,
    amount_inr: parsed.amount_inr,
    merchant_raw: parsed.merchant_raw,
    occurred_at: parsed.datetime,
    card_last4: parsed.card_last4,
    direction: parsed.direction,
    is_reversal: parsed.is_reversal,
    is_international: parsed.is_international,
  };
}

function safeSnippet(message: gmail_v1.Schema$Message, parserStatus: ParserStatus): string {
  // Known senders also deliver OTP/SafeKey and other account-security mail.
  // Those messages are useful as diagnostic metadata but their content must
  // never leave Gmail through this tool.
  if (parserStatus === "ignored") return "";
  return (message.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function normalizeArgs(
  args: SearchTransactionEmailsArgs,
  now: Date
): { provider: DiagnosticProvider; start: Date; end: Date; limit: number } {
  const provider = args.provider ?? "all";
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`provider must be one of: ${PROVIDERS.join(", ")}`);
  }

  const today = currentIstDate(now);
  const start = args.start_date
    ? parseDateOnly(args.start_date, "start_date")
    : addUtcDays(today, -(DEFAULT_LOOKBACK_DAYS - 1));
  const end = args.end_date ? parseDateOnly(args.end_date, "end_date") : today;
  const windowDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (windowDays < 1) throw new Error("end_date must be on or after start_date");
  if (windowDays > MAX_WINDOW_DAYS) {
    throw new Error(`date window cannot exceed ${MAX_WINDOW_DAYS} days`);
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { provider, start, end, limit };
}

export async function searchTransactionEmails(
  db: Database.Database,
  args: SearchTransactionEmailsArgs = {},
  options: SearchTransactionEmailsOptions = {}
): Promise<SearchTransactionEmailsResult> {
  const { provider, start, end, limit } = normalizeArgs(args, options.now ?? new Date());
  const gmail = options.gmail ?? getGmailClient();
  const senders = resolveSenders(provider);
  // Gmail's `after:` operator is exclusive. Subtract one second so the
  // requested IST start date remains inclusive even at exactly midnight.
  const startSeconds = dateOnlyToIstEpochSeconds(start) - 1;
  const endExclusive = addUtcDays(end, 1);
  const endSeconds = dateOnlyToIstEpochSeconds(endExclusive);
  const query = `from:(${senders.join(" OR ")}) after:${startSeconds} before:${endSeconds}`;
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: limit,
  });
  const processedIds = parseStringSet(db, "processed_message_ids");
  const unparseableIds = parseStringSet(db, "unparseable_gmail_message_ids");
  const messages: TransactionEmailDiagnostic[] = [];

  for (const listed of list.data.messages ?? []) {
    if (!listed.id || messages.length >= limit) continue;
    const response = await gmail.users.messages.get({ userId: "me", id: listed.id, format: "full" });
    const message = response.data;
    const parsed = parseGmailMessage(message);
    const likely = isLikelyTransactionAlert(message);
    const parserStatus: ParserStatus = parsed ? "matched" : likely ? "unparseable" : "ignored";
    const raw = db
      .prepare("SELECT id FROM raw_transactions WHERE raw_email_id = ?")
      .get(listed.id) as { id: string } | undefined;
    let storageStatus: StorageStatus;
    if (raw) storageStatus = "ingested";
    else if (parserStatus === "ignored") storageStatus = "ignored";
    else if (unparseableIds.has(listed.id)) storageStatus = "retry_pending";
    else if (processedIds.has(listed.id)) storageStatus = "processed_without_raw";
    else storageStatus = "missing";

    messages.push({
      message_id: listed.id,
      thread_id: message.threadId ?? null,
      sender: header(message, "from"),
      subject: header(message, "subject"),
      received_at: getGmailReceivedAt(message),
      snippet: safeSnippet(message, parserStatus),
      parser_status: parserStatus,
      storage_status: storageStatus,
      raw_transaction_id: raw?.id ?? null,
      parsed_transaction: parsed ? buildParsedSummary(parsed) : null,
    });
  }

  messages.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  return {
    status: "ok",
    provider,
    start_date: formatDateOnly(start),
    end_date: formatDateOnly(end),
    count: messages.length,
    messages,
    poller: getPollerState(db),
    privacy:
      "Read-only search limited to configured transaction senders; full bodies and non-transaction snippets are never returned.",
  };
}

export function describeGmailDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid_grant")) {
    return "Gmail authorization expired or was revoked. Replace GMAIL_REFRESH_TOKEN.";
  }
  if (normalized.includes("insufficient permission") || normalized.includes("insufficient_scope")) {
    return (
      "Gmail authorization is missing read access. Reauthorize with " +
      "https://www.googleapis.com/auth/gmail.readonly."
    );
  }
  if (
    normalized.includes("must use yyyy-mm-dd") ||
    normalized.includes("valid calendar date") ||
    normalized.includes("date window") ||
    normalized.includes("end_date must") ||
    normalized.includes("provider must") ||
    normalized.includes("limit must")
  ) {
    return message;
  }
  return "Gmail diagnostic query failed. Check /health and the Plutus server logs.";
}
