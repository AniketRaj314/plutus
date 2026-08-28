import OpenAI from "openai";
import type Database from "better-sqlite3";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { buildSystemPrompt } from "./prompts";
import { v2Tools as tools } from "./v2-tools";
import { getCounterpartyBalance, getRawTransaction } from "../db/v2-queries";
import { listRecentAgentMessages, insertAgentMessage, getTransaction } from "../db/queries";
import { getVioletModelConfig } from "./model-config";
import {
  buildUserInputItem,
  persistedImageMessage,
  type AgentImageInput,
} from "./image-input";

const MAX_TOOL_ITERATIONS = 20;
const MAX_COMPLETION_TOKENS = 8000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    client = new OpenAI({ apiKey });
  }
  return client;
}

function toOpenAiTools(): FunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

export interface RunAgentPayload {
  user_message: string;
  interface: "telegram" | "api";
  replied_to_transaction_id?: string;
  images?: AgentImageInput[];
}

export interface RunAgentOptions {
  createResponse?: (
    request: ResponseCreateParamsNonStreaming
  ) => Promise<Response>;
}

function successfulToolResult(result: unknown): boolean {
  return !(
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    Boolean((result as { error?: unknown }).error)
  );
}

export function counterpartyAffectedByTool(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): string | null {
  if (!successfulToolResult(result)) return null;
  if (
    toolName === "record_counterparty_transfer" ||
    toolName === "create_receivable" ||
    toolName === "create_counterparty_balance_checkpoint"
  ) {
    return typeof args.counterparty === "string" && args.counterparty.trim()
      ? args.counterparty.trim()
      : null;
  }
  if (
    toolName === "set_context_fact" &&
    args.scope_type === "person" &&
    typeof args.scope_id === "string" &&
    typeof args.key === "string" &&
    (args.key.startsWith("counterparty_payable_") ||
      args.key.startsWith("counterparty_transfer"))
  ) {
    return args.scope_id.trim() || null;
  }
  if (toolName === "update_receivable") {
    const counterparty =
      typeof result === "object" && result !== null
        ? (result as { counterparty?: unknown }).counterparty
        : null;
    return typeof counterparty === "string" && counterparty.trim()
      ? counterparty.trim()
      : null;
  }
  return null;
}

export async function runAgent(
  db: Database.Database,
  payload: RunAgentPayload,
  options: RunAgentOptions = {}
): Promise<string> {
  const systemPrompt = buildSystemPrompt(db);

  const history: ResponseInputItem[] = listRecentAgentMessages(db, 50)
    .slice()
    .reverse()
    .map((m) => ({
      role: (m.role as "user" | "assistant" | "system") ?? "user",
      content: m.content ?? "",
    }));

  let effectiveUserMessage = payload.user_message;
  if (payload.replied_to_transaction_id) {
    const transaction = getTransaction(db, payload.replied_to_transaction_id);
    const raw = getRawTransaction(db, payload.replied_to_transaction_id);
    if (transaction || raw) {
      const contextLine = `[Context: user is referring to transaction — ${
        transaction?.merchant_clean ?? transaction?.merchant_raw ?? raw?.merchant_raw ?? "Unknown"
      } · ₹${transaction?.amount ?? raw?.amount ?? 0} · ${
        transaction?.datetime ?? raw?.occurred_at ?? "unknown date"
      } · ${transaction?.direction ?? raw?.direction ?? "debit"} · ${
        transaction?.category ?? "uncategorized"
      } · raw_transaction_id=${payload.replied_to_transaction_id}]`;
      effectiveUserMessage = `${contextLine}\n${payload.user_message}`;
    }
  }

  const input: ResponseInputItem[] = [
    ...history,
    buildUserInputItem(effectiveUserMessage, payload.images),
  ];

  const toolDefs = toOpenAiTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const modelConfig = getVioletModelConfig();
  const pendingCounterpartyRefreshes = new Map<string, string>();
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
      tools: toolDefs,
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
      if (pendingCounterpartyRefreshes.size > 0) {
        const refreshed = [...pendingCounterpartyRefreshes.values()].map((counterparty) =>
          getCounterpartyBalance(db, counterparty, { view: "current" })
        );
        pendingCounterpartyRefreshes.clear();
        input.push({
          role: "developer",
          content:
            "POST-WRITE CANONICAL REFRESH: A balance-affecting write occurred in this turn. " +
            "Discard any balance number drafted before this message. Use only these freshly " +
            `queried counterparty balances in the final answer: ${JSON.stringify(refreshed)}`,
        });
        continue;
      }
      finalText = response.output_text ?? "";
      break;
    }

    for (const toolCall of toolCalls) {
      const tool = toolMap.get(toolCall.name);
      let result: unknown;

      if (!tool) {
        result = { error: `unknown tool: ${toolCall.name}` };
      } else {
        try {
          const args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
          result = await tool.handler(db, args);
          if (toolCall.name === "get_counterparty_balance") {
            const counterparty =
              typeof args.counterparty === "string" ? args.counterparty.trim() : "";
            if (counterparty) pendingCounterpartyRefreshes.delete(counterparty.toLowerCase());
          }
          const affectedCounterparty = counterpartyAffectedByTool(
            toolCall.name,
            args,
            result
          );
          if (affectedCounterparty) {
            pendingCounterpartyRefreshes.set(
              affectedCounterparty.toLowerCase(),
              affectedCounterparty
            );
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
      });
    }

    if (i === MAX_TOOL_ITERATIONS - 1) {
      finalText = "That's a lot to set up in one go — let's do it in parts. Can you tell me one committed expense at a time?";
    }
  }

  insertAgentMessage(db, {
    role: "user",
    content: persistedImageMessage(effectiveUserMessage, payload.images?.length ?? 0),
    interface: payload.interface,
  });
  insertAgentMessage(db, { role: "assistant", content: finalText, interface: payload.interface });

  return finalText;
}
