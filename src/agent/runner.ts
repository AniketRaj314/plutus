import OpenAI from "openai";
import type Database from "better-sqlite3";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { buildSystemPrompt } from "./prompts";
import { tools } from "./tools";
import { listRecentAgentMessages, insertAgentMessage, getTransaction } from "../db/queries";

const MODEL = "o3";
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

function toOpenAiTools(): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export interface RunAgentPayload {
  user_message: string;
  interface: "telegram" | "api";
  replied_to_transaction_id?: string;
}

export async function runAgent(db: Database.Database, payload: RunAgentPayload): Promise<string> {
  const systemPrompt = buildSystemPrompt(db);

  const history: ChatCompletionMessageParam[] = listRecentAgentMessages(db, 50)
    .slice()
    .reverse()
    .map((m) => ({
      role: (m.role as "user" | "assistant" | "system") ?? "user",
      content: m.content ?? "",
    }));

  let effectiveUserMessage = payload.user_message;
  if (payload.replied_to_transaction_id) {
    const transaction = getTransaction(db, payload.replied_to_transaction_id);
    if (transaction) {
      const contextLine = `[Context: user is referring to transaction — ${
        transaction.merchant_clean ?? transaction.merchant_raw ?? "Unknown"
      } · ₹${transaction.amount ?? 0} · ${transaction.datetime ?? "unknown date"} · ${
        transaction.category ?? "uncategorized"
      }]`;
      effectiveUserMessage = `${contextLine}\n${payload.user_message}`;
    }
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: effectiveUserMessage },
  ];

  const openai = getClient();
  const toolDefs = toOpenAiTools();
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  let finalText = "";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 1,
      messages,
      tools: toolDefs,
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

      const tool = toolMap.get(toolCall.function.name);
      let result: unknown;

      if (!tool) {
        result = { error: `unknown tool: ${toolCall.function.name}` };
      } else {
        try {
          const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
          result = await tool.handler(db, args);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    if (i === MAX_TOOL_ITERATIONS - 1) {
      finalText = "That's a lot to set up in one go — let's do it in parts. Can you tell me one committed expense at a time?";
    }
  }

  insertAgentMessage(db, { role: "user", content: effectiveUserMessage, interface: payload.interface });
  insertAgentMessage(db, { role: "assistant", content: finalText, interface: payload.interface });

  return finalText;
}
