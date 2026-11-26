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
  type FlexBudgetClassification,
} from "../db/v2-queries";
import { getVioletModelConfig } from "./model-config";
import { getActiveTelegramContributor } from "../telegram/access";
import {
  buildUserInputItem,
  persistedImageMessage,
  type AgentImageInput,
} from "./image-input";

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
  images?: AgentImageInput[];
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
  return `You are Violet helping ${identity.name} understand their shared tab with Aniket.
CURRENT TIME: ${currentIst()} IST
This compatibility entry point is read-only. New expenses in either direction, receipts, corrections and payment reports belong to the shared conversation and require Aniket's approval before any ledger change.
Call get_my_tab_with_aniket immediately before answering any balance or history question. Use current by default, full only for explicitly requested lifetime history. Never infer a balance from history.
The tool is identity-bound. Never ask for or accept another person's name as a lookup target. You cannot access unrelated finances.
Never claim a purchase was recorded or a review sent. Keep replies natural and brief, ask only missing questions, and do not require menu commands. Never use an em dash. Write simple Markdown, never raw HTML.`;
}

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

export async function runContributorAgent(
  db: Database.Database,
  payload: ContributorAgentPayload,
  options: RunContributorAgentOptions = {}
): Promise<ContributorAgentResult> {
  const verifyAccess = () => {
    const current = getActiveTelegramContributor(db, payload.identity.telegram_user_id);
    if (!current || current.private_chat_id !== payload.conversation_id) {
      throw new Error("Active private contributor access required");
    }
    payload.identity = {
      telegram_user_id: current.telegram_user_id,
      name: current.counterparty_name,
    };
  };
  verifyAccess();
  const systemPrompt = buildContributorSystemPrompt(payload.identity);
  const input: ResponseInputItem[] = [
    ...listHistory(db, payload.identity.telegram_user_id, payload.conversation_id),
    buildUserInputItem(payload.user_message, payload.images),
  ];
  const receipts: ContributorPurchaseReceipt[] = [];
  const modelConfig = getVioletModelConfig();
  const createResponse =
    options.createResponse ??
    ((request: ResponseCreateParamsNonStreaming) => getClient().responses.create(request));
  let finalText = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await createResponse({
      model: modelConfig.model,
      reasoning: { effort: modelConfig.reasoning_effort },
      instructions: systemPrompt,
      input,
      tools: [CONTRIBUTOR_BALANCE_TOOL],
      parallel_tool_calls: false,
      max_output_tokens: MAX_COMPLETION_TOKENS,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    const toolCalls = response.output.filter(
      (item): item is ResponseFunctionToolCall => item.type === "function_call"
    );
    verifyAccess();
    input.push(...(response.output as ResponseInputItem[]));
    if (toolCalls.length === 0) {
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
  verifyAccess();
  insertHistory(
    db,
    payload,
    "user",
    persistedImageMessage(payload.user_message, payload.images?.length ?? 0)
  );
  insertHistory(db, payload, "assistant", finalText);
  return { text: finalText, recorded_purchases: receipts };
}
