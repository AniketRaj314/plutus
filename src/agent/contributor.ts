import OpenAI from "openai";
import type Database from "better-sqlite3";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import {
  getCounterpartyBalance,
  recordContributorPurchase,
  type FlexBudgetClassification,
  type RecordContributorPurchaseResult,
} from "../db/v2-queries";
import { getVioletModelConfig } from "./model-config";

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

export interface RunContributorAgentOptions {
  createResponse?: (
    request: ResponseCreateParamsNonStreaming
  ) => Promise<Response>;
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
  return `You are Violet's privacy-restricted bilateral finance assistant for ${identity.name}, an authorized contributor to Aniket's personal Plutus ledger.

CURRENT TIME: ${currentIst()} IST

YOUR ONLY JOBS:
- Help ${identity.name} record a purchase or payment they personally made on Aniket's behalf.
- Help ${identity.name} review only the two-way tab between ${identity.name} and Aniket: what they covered for each other, direct transfers between them, and their net balance.
- You have no access to Aniket's financial history, transactions, balances, cards, income, budgets, reimbursements, or other people's activity.
- Never claim to know or reveal any unrelated information. If asked, say: "I can only help with payments and the shared tab between you and Aniket."
- For every shared-tab, debt, balance, or history question, call get_my_tab_with_aniket immediately before answering. Never answer from conversation history.
- Use view=current by default. Use view=full only when ${identity.name} explicitly asks for lifetime, old, or full history.
- The shared-tab tool is identity-bound. Never ask for or accept another person's name as a lookup target.

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
- After recording, you may state the resulting bilateral balance only by calling get_my_tab_with_aniket.
- Keep replies to 2-6 short lines. Show a compact net first and only the bilateral items needed to answer; expand only when asked.`;
}

const CONTRIBUTOR_TOOL: FunctionTool = {
  type: "function",
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
  strict: false,
};

const CONTRIBUTOR_BALANCE_TOOL: FunctionTool = {
  type: "function",
  name: "get_my_tab_with_aniket",
  description:
    "Get the authenticated contributor's own bilateral tab with Aniket. Identity is injected by the server; no counterparty can be selected.",
  parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["current", "full"],
          description: "Defaults to current. Full is only for an explicit lifetime/history request.",
        },
      },
      required: [],
  },
  strict: false,
};

export function getContributorBalanceView(
  db: Database.Database,
  identity: ContributorIdentity,
  view: "current" | "full" = "current"
): unknown {
  const balance = getCounterpartyBalance(db, identity.name, { view });
  const item = (entry: (typeof balance.value_from_user)[number]) => ({
    kind: entry.kind,
    label: entry.label,
    amount_inr: entry.amount_inr,
    occurred_at: entry.occurred_at,
  });
  const net =
    balance.result === "counterparty_owes_user"
      ? { direction: "you_owe_aniket", amount_inr: Math.abs(balance.net_balance_inr) }
      : balance.result === "user_owes_counterparty"
        ? { direction: "aniket_owes_you", amount_inr: Math.abs(balance.net_balance_inr) }
        : { direction: "settled", amount_inr: 0 };
  return {
    view: balance.view,
    opening_balance_inr_from_aniket_perspective: balance.opening_balance_inr,
    value_you_provided: balance.value_from_counterparty.map(item),
    value_aniket_provided: balance.value_from_user.map(item),
    total_value_you_provided_inr: balance.total_from_counterparty_inr,
    total_value_aniket_provided_inr: balance.total_from_user_inr,
    net,
    unresolved_item_count: balance.uncertain.length,
    privacy_note:
      "This view contains only bilateral amounts linked to the authenticated contributor and Aniket.",
  };
}

function listHistory(
  db: Database.Database,
  telegramUserId: string,
  conversationId: string
): ResponseInputItem[] {
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
  payload: ContributorAgentPayload,
  options: RunContributorAgentOptions = {}
): Promise<ContributorAgentResult> {
  const systemPrompt = buildContributorSystemPrompt(payload.identity);
  const input: ResponseInputItem[] = [
    ...listHistory(db, payload.identity.telegram_user_id, payload.conversation_id),
    { role: "user", content: payload.user_message },
  ];
  const receipts: ContributorPurchaseReceipt[] = [];
  const modelConfig = getVioletModelConfig();
  const createResponse =
    options.createResponse ??
    ((request: ResponseCreateParamsNonStreaming) => getClient().responses.create(request));
  let needsBalanceRefresh = false;
  let finalText = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await createResponse({
      model: modelConfig.model,
      reasoning: { effort: modelConfig.reasoning_effort },
      instructions: systemPrompt,
      input,
      tools: [CONTRIBUTOR_TOOL, CONTRIBUTOR_BALANCE_TOOL],
      parallel_tool_calls: false,
      max_output_tokens: MAX_COMPLETION_TOKENS,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    const toolCalls = response.output.filter(
      (item): item is ResponseFunctionToolCall => item.type === "function_call"
    );
    input.push(...(response.output as ResponseInputItem[]));
    if (toolCalls.length === 0) {
      if (needsBalanceRefresh) {
        const refreshed = getContributorBalanceView(db, payload.identity, "current");
        needsBalanceRefresh = false;
        input.push({
          role: "developer",
          content:
            "POST-WRITE CANONICAL REFRESH: A purchase was recorded in this turn. " +
            "Discard any balance number drafted before this message. Use only this freshly " +
            `queried bilateral balance in the final answer: ${JSON.stringify(refreshed)}`,
        });
        continue;
      }
      finalText = response.output_text ?? "";
      break;
    }

    for (const toolCall of toolCalls) {
      let toolResult: unknown;
      try {
        if (toolCall.name === "get_my_tab_with_aniket") {
          const args = JSON.parse(toolCall.arguments || "{}") as {
            view?: "current" | "full";
          };
          toolResult = getContributorBalanceView(
            db,
            payload.identity,
            args.view === "full" ? "full" : "current"
          );
          needsBalanceRefresh = false;
        } else if (toolCall.name === "record_purchase_for_aniket") {
          const args = JSON.parse(toolCall.arguments || "{}") as {
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
          needsBalanceRefresh = true;
          toolResult = {
            recorded: true,
            raw_transaction_id: receipt.raw_transaction_id,
            label: receipt.label,
            date: receipt.occurred_at.slice(0, 10),
            total_paid_inr: receipt.gross_amount_inr,
            aniket_share_inr: receipt.owner_share_inr,
            was_existing: receipt.was_existing,
          };
        } else {
          throw new Error("unsupported contributor tool");
        }
      } catch (error) {
        toolResult = { error: error instanceof Error ? error.message : String(error) };
      }
      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(toolResult),
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
