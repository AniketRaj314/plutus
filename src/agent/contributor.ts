import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  recordContributorPurchase,
  type FlexBudgetClassification,
  type RecordContributorPurchaseResult,
} from "../db/v2-queries";

const MODEL = "o3";
const MAX_TOOL_ITERATIONS = 8;
const MAX_COMPLETION_TOKENS = 1800;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    client = new OpenAI({ apiKey });
  }
  return client;
}

export interface ContributorIdentity {
  telegram_user_id: string;
  name: string;
}

export interface ContributorAgentPayload {
  identity: ContributorIdentity;
  conversation_id: string;
  message_id: number;
  user_message: string;
}

export interface ContributorPurchaseReceipt {
  raw_transaction_id: string;
  label: string;
  occurred_at: string;
  gross_amount_inr: number;
  owner_share_inr: number;
  category: string | null;
  treatment: string;
  flex_classification: FlexBudgetClassification | null;
  was_existing: boolean;
  reporter: string;
}

export interface ContributorAgentResult {
  text: string;
  recorded_purchases: ContributorPurchaseReceipt[];
}

function currentIst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function buildContributorSystemPrompt(identity: ContributorIdentity): string {
  return `You are Violet's privacy-restricted expense intake for ${identity.name}, an authorized contributor to Aniket's personal Plutus ledger.

CURRENT TIME: ${currentIst()} IST

YOUR ONLY JOB:
- Help ${identity.name} record a purchase or payment they personally made on Aniket's behalf.
- You have no access to Aniket's financial history, transactions, balances, cards, income, budgets, reimbursements, or other people's activity.
- Never claim to know or reveal any of that information. If asked, say: "I can only help record payments you made for Aniket."
- Never answer debt or balance questions, even about ${identity.name}.

BEFORE RECORDING, establish:
- what was paid for;
- total amount paid;
- Aniket's share (use the full amount only when ${identity.name} clearly says the whole payment was for Aniket);
- purchase date (ask if it is not clear; do not invent it).

RECORDING RULES:
- Handle one purchase per message. Ask for separate messages when multiple purchases are bundled.
- Call record_purchase_for_aniket only after the details above are clear.
- Ordinary variable groceries, dining, travel, entertainment, and shopping are flex.
- Fixed is only for genuinely recurring or non-negotiable obligations.
- Excluded is only for pass-throughs, settlements, or an explicitly reimbursable purchase.
- A payment of an existing card bill or debt may duplicate an already tracked expense. Do not record it as a new purchase; tell ${identity.name} that Aniket needs to review it.
- Never say something was recorded unless the tool succeeded.
- Keep replies to 2-5 short lines. Confirm only the submitted purchase; do not include account totals or balances.`;
}

const CONTRIBUTOR_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "record_purchase_for_aniket",
    description:
      "Record one purchase the authenticated contributor personally paid for on Aniket's behalf. The authenticated reporter identity is injected by the server and cannot be selected by the model.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        occurred_at: {
          type: "string",
          description: "Purchase date as YYYY-MM-DD, or an ISO 8601 timestamp when known.",
        },
        gross_amount_inr: { type: "number" },
        owner_share_inr: {
          type: "number",
          description: "The portion of the purchase economically belonging to Aniket.",
        },
        category: { type: "string" },
        treatment: { type: "string" },
        flex_classification: {
          type: "string",
          enum: ["flex", "fixed", "excluded"],
        },
        notes: { type: "string" },
      },
      required: [
        "label",
        "occurred_at",
        "gross_amount_inr",
        "owner_share_inr",
        "category",
        "treatment",
        "flex_classification",
      ],
    },
  },
};

function listHistory(
  db: Database.Database,
  telegramUserId: string,
  conversationId: string
): ChatCompletionMessageParam[] {
  const rows = db
    .prepare(
      `SELECT role, content FROM contributor_agent_messages
       WHERE telegram_user_id = ? AND conversation_id = ?
       ORDER BY id DESC LIMIT 20`
    )
    .all(telegramUserId, conversationId) as Array<{ role: "user" | "assistant"; content: string }>;
  return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

function insertHistory(
  db: Database.Database,
  payload: ContributorAgentPayload,
  role: "user" | "assistant",
  content: string
): void {
  db.prepare(
    `INSERT INTO contributor_agent_messages (
      telegram_user_id, conversation_id, role, content
    ) VALUES (?, ?, ?, ?)`
  ).run(payload.identity.telegram_user_id, payload.conversation_id, role, content);
}

function toReceipt(
  result: RecordContributorPurchaseResult,
  reporter: string
): ContributorPurchaseReceipt {
  return {
    raw_transaction_id: result.raw.id,
    label: result.entry.merchant_clean ?? result.raw.merchant_raw ?? "Purchase",
    occurred_at: result.entry.occurred_at ?? result.raw.occurred_at,
    gross_amount_inr: result.entry.gross_amount_inr,
    owner_share_inr: result.entry.personal_impact,
    category: result.entry.category,
    treatment: result.entry.treatment,
    flex_classification: result.flex_classification?.classification ?? null,
    was_existing: result.was_existing,
    reporter,
  };
}

export async function runContributorAgent(
  db: Database.Database,
  payload: ContributorAgentPayload
): Promise<ContributorAgentResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildContributorSystemPrompt(payload.identity) },
    ...listHistory(db, payload.identity.telegram_user_id, payload.conversation_id),
    { role: "user", content: payload.user_message },
  ];
  const receipts: ContributorPurchaseReceipt[] = [];
  let finalText = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 1,
      messages,
      tools: [CONTRIBUTOR_TOOL],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    });
    const message = completion.choices[0].message;
    if (!message.tool_calls || message.tool_calls.length === 0) {
      finalText = message.content ?? "";
      break;
    }

    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls,
    });
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;
      let toolResult: unknown;
      try {
        if (toolCall.function.name !== "record_purchase_for_aniket") {
          throw new Error("unsupported contributor tool");
        }
        const args = JSON.parse(toolCall.function.arguments || "{}") as {
          label: string;
          occurred_at: string;
          gross_amount_inr: number;
          owner_share_inr: number;
          category: string;
          treatment: string;
          flex_classification: FlexBudgetClassification;
          notes?: string;
        };
        const result = recordContributorPurchase(db, {
          idempotency_key: `${payload.identity.telegram_user_id}:${payload.conversation_id}:${payload.message_id}`,
          reporter: payload.identity.name,
          reporter_telegram_user_id: payload.identity.telegram_user_id,
          occurred_at: args.occurred_at,
          gross_amount_inr: args.gross_amount_inr,
          owner_share_inr: args.owner_share_inr,
          label: args.label,
          category: args.category,
          treatment: args.treatment,
          flex_classification: args.flex_classification,
          notes: args.notes,
        });
        const receipt = toReceipt(result, payload.identity.name);
        receipts.push(receipt);
        toolResult = {
          recorded: true,
          raw_transaction_id: receipt.raw_transaction_id,
          label: receipt.label,
          date: receipt.occurred_at.slice(0, 10),
          total_paid_inr: receipt.gross_amount_inr,
          aniket_share_inr: receipt.owner_share_inr,
          was_existing: receipt.was_existing,
        };
      } catch (error) {
        toolResult = { error: error instanceof Error ? error.message : String(error) };
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (!finalText) {
    finalText = "I couldn't safely finish that entry. Please send one payment with the amount, date, and what it was for.";
  }
  insertHistory(db, payload, "user", payload.user_message);
  insertHistory(db, payload, "assistant", finalText);
  return { text: finalText, recorded_purchases: receipts };
}
