import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleTelegramUpdate, type TelegramUpdate } from "../telegram/bot";
import { runAgent } from "../agent/runner";
import { todayIst, daysUntilSalaryDay } from "../agent/prompts";
import { tools as agentTools } from "../agent/tools";
import {
  queryTransactions,
  getTransaction,
  getEnvelope,
  listAllSplits,
  listTransactions,
  listContext,
  setContext,
  listCommittedExpenses,
  listCreditCards,
} from "../db/queries";
import { getRemainingWeeksInMonth, parseIstDateOnly, getBillingWindow } from "../envelope/engine";
import { getSchedulerHealth } from "../scheduler/status";
import { describeGmailDiagnosticError, searchTransactionEmails } from "../gmail/diagnostics";

const VALID_SOURCES = ["idfc_cc", "icici_cc", "bobcard", "amex", "idfc_upi"];
const MAX_TRANSACTIONS_LIMIT = 100;
const AGENT_TIMEOUT_MS = 120_000;
const AGENT_RATE_LIMIT_MAX = 10;
const AGENT_RATE_LIMIT_WINDOW_MS = 60_000;
export const PACKAGE_VERSION = (require("../../package.json") as { version?: string }).version ?? "unknown";

// -- webhook + health (unchanged, no auth) --

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post("/webhook/telegram", async (request, reply) => {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const receivedSecret = request.headers["x-telegram-bot-api-secret-token"];
      if (receivedSecret !== expectedSecret) {
        console.warn(`[telegram] rejected webhook call with invalid/missing secret token from ${request.ip}`);
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
    }

    reply.status(200).send({ ok: true });

    handleTelegramUpdate(db, request.body as TelegramUpdate).catch((err) => {
      console.error("[telegram] webhook handling failed:", err);
    });
  });

  app.get("/health", async (_request, reply) => {
    try {
      db.prepare("SELECT 1").get();
    } catch (err) {
      console.error("[health] DB check failed:", err);
      reply.status(503);
      return { status: "degraded", db: "error" };
    }

    const checkedAt = new Date();
    const schedulerHealth = getSchedulerHealth(checkedAt);
    const failedSchedulers = Object.values(schedulerHealth.schedulers)
      .filter((scheduler) => scheduler.enabled && scheduler.last_outcome === "error")
      .map((scheduler) => scheduler.name);
    const status = failedSchedulers.length > 0 ? "degraded" : "ok";
    if (status === "degraded") reply.status(503);
    return {
      status,
      version: PACKAGE_VERSION,
      checked_at: checkedAt.toISOString(),
      uptime: process.uptime(),
      db: "ok",
      node_version: process.version,
      environment: process.env.NODE_ENV,
      poll_interval: process.env.POLL_INTERVAL_MINS,
      auto_inference_enabled: process.env.AUTO_INFERENCE_ENABLED !== "false",
      auto_inference_interval: process.env.AUTO_INFERENCE_INTERVAL_MINS ?? "5",
      degraded_components: failedSchedulers,
      ...schedulerHealth,
    };
  });
}

// -- REST API (bearer-token auth, CORS, rate limiting on /agent) --

export function registerApiRoutes(app: FastifyInstance, db: Database.Database): void {
  app.register(async (api) => {
    api.addHook("onRequest", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    });

    api.options("/*", async (_request, reply) => {
      reply.status(204).send();
    });

    api.addHook("preHandler", async (request, reply) => {
      if (request.method === "OPTIONS") return;

      const expected = process.env.API_BEARER_TOKEN;
      const header = request.headers.authorization;

      if (!expected || !header || header !== `Bearer ${expected}`) {
        console.warn(`[api] rejected unauthorized request from ${request.ip}`);
        sendError(reply, 401, "Unauthorized");
        return reply;
      }
    });

    api.post(
      "/agent",
      { preHandler: agentRateLimit },
      async (request, reply) => {
        request.raw.setTimeout(AGENT_TIMEOUT_MS);
        reply.raw.setTimeout(AGENT_TIMEOUT_MS);

        const body = request.body as { message?: string; interface?: string } | undefined;
        if (!body?.message || typeof body.message !== "string") {
          return sendError(reply, 400, "Bad request", "'message' is required and must be a string");
        }

        try {
          const response = await runAgent(db, {
            user_message: body.message,
            interface: (body.interface as "telegram" | "api") ?? "api",
          });
          return { response, timestamp: new Date().toISOString() };
        } catch (err) {
          return handleInternalError(reply, err, "agent run failed");
        }
      }
    );

    api.get("/transactions", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;

      if (query.source && !VALID_SOURCES.includes(query.source)) {
        return sendError(reply, 400, "Bad request", `source must be one of: ${VALID_SOURCES.join(", ")}`);
      }

      let minAmount: number | undefined;
      if (query.min_amount !== undefined) {
        minAmount = Number(query.min_amount);
        if (Number.isNaN(minAmount)) {
          return sendError(reply, 400, "Bad request", "min_amount must be a number");
        }
      }

      let limit = query.limit !== undefined ? Number(query.limit) : 20;
      if (Number.isNaN(limit) || limit < 1) limit = 20;
      limit = Math.min(limit, MAX_TRANSACTIONS_LIMIT);

      const filters = {
        since: query.since,
        until: query.until,
        source: query.source,
        category: query.category,
        min_amount: minAmount,
        limit,
      };

      try {
        const transactions = queryTransactions(db, filters);
        return { transactions, count: transactions.length, filters_applied: filters };
      } catch (err) {
        return handleInternalError(reply, err, "failed to query transactions");
      }
    });

    api.get("/transactions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const transaction = getTransaction(db, id);
        if (!transaction) return sendError(reply, 404, "Transaction not found");
        return transaction;
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch transaction");
      }
    });

    api.get("/envelope", async (_request, reply) => {
      try {
        const envelope = getEnvelope(db);
        if (!envelope) return sendError(reply, 404, "Envelope not configured");

        const weekProgressPct = envelope.current_week_budget
          ? round2(((envelope.current_week_spent ?? 0) / envelope.current_week_budget) * 100)
          : 0;
        const monthProgressPct = envelope.discretionary_pool
          ? round2(((envelope.spent_discretionary ?? 0) / envelope.discretionary_pool) * 100)
          : 0;

        const weekStart = envelope.current_week_start
          ? parseIstDateOnly(envelope.current_week_start)
          : getWeekStartFallback();
        const month = envelope.month ?? monthStringFromDate(todayIst());
        const weeksRemaining = getRemainingWeeksInMonth(weekStart, month);

        return {
          ...envelope,
          week_progress_pct: weekProgressPct,
          month_progress_pct: monthProgressPct,
          days_until_salary: daysUntilSalaryDay(envelope.salary_day),
          weeks_remaining_in_month: weeksRemaining,
        };
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch envelope");
      }
    });

    api.get("/splits", async (_request, reply) => {
      try {
        const all = listAllSplits(db);
        const owedToMe = all.filter((s) => s.paid_by_you && !s.settled);
        const iOwe = all.filter((s) => !s.paid_by_you && !s.settled);

        const withTransaction = (split: (typeof all)[number]) => {
          const transaction = split.transaction_id ? getTransaction(db, split.transaction_id) : undefined;
          return {
            ...split,
            transaction: transaction
              ? {
                  merchant_clean: transaction.merchant_clean,
                  amount: transaction.amount,
                  datetime: transaction.datetime,
                }
              : null,
          };
        };

        const totalOwedToMe = owedToMe.reduce(
          (sum, s) => sum + ((s.total_amount ?? 0) - (s.your_share ?? 0)),
          0
        );
        const totalIOwe = iOwe.reduce((sum, s) => sum + (s.your_share ?? 0), 0);

        return {
          owed_to_me: owedToMe.map(withTransaction),
          i_owe: iOwe.map(withTransaction),
          total_owed_to_me: round2(totalOwedToMe),
          total_i_owe: round2(totalIOwe),
        };
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch splits");
      }
    });

    api.get("/summary/:period", async (request, reply) => {
      const { period } = request.params as { period: string };
      if (period !== "week" && period !== "month") {
        return sendError(reply, 400, "Bad request", "period must be 'week' or 'month'");
      }

      try {
        const envelope = getEnvelope(db);
        const all = listTransactions(db, 2000);

        let sinceIso: string;
        if (period === "week" && envelope?.current_week_start) {
          sinceIso = `${envelope.current_week_start}T00:00:00.000Z`;
        } else {
          const month = envelope?.month ?? monthStringFromDate(todayIst());
          sinceIso = `${month}-01T00:00:00.000Z`;
        }

        const inPeriod = all.filter((t) => t.datetime && t.datetime >= sinceIso);

        let totalSpent = 0;
        const byCategory: Record<string, { total: number; count: number }> = {};
        const byMerchant: Record<string, { total: number; count: number }> = {};
        let internationalPendingCount = 0;
        let lowConfidenceCount = 0;
        let includedTransactionCount = 0;

        for (const t of inPeriod) {
          if (t.is_cancelled_out || t.is_credit_card_payment) continue;
          if (t.is_international && t.amount_inr === null) {
            internationalPendingCount++;
            continue;
          }
          const amount = t.is_international ? t.amount_inr ?? 0 : t.amount ?? 0;
          const signed = t.is_reversal ? -amount : amount;
          totalSpent += signed;
          includedTransactionCount++;

          const category = t.category ?? "Uncategorized";
          if (!byCategory[category]) byCategory[category] = { total: 0, count: 0 };
          byCategory[category].total += signed;
          byCategory[category].count += 1;

          const merchant = t.merchant_clean ?? t.merchant_raw ?? "Unknown";
          if (!byMerchant[merchant]) byMerchant[merchant] = { total: 0, count: 0 };
          byMerchant[merchant].total += signed;
          byMerchant[merchant].count += 1;

          if (t.notes === "enrichment_failed" || (t.enrichment_confidence !== null && t.enrichment_confidence < 0.7)) {
            lowConfidenceCount++;
          }
        }

        return {
          period,
          metric: "legacy_raw_activity_inr",
          warning: "Raw calendar activity is not true personal spend. Use the v2 funding summary for salary-envelope reasoning.",
          total_spent: round2(totalSpent),
          transaction_count: includedTransactionCount,
          by_category: Object.entries(byCategory)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([category, v]) => ({ category, total: round2(v.total), count: v.count })),
          top_merchants: Object.entries(byMerchant)
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 5)
            .map(([merchant_clean, v]) => ({ merchant_clean, total: round2(v.total), count: v.count })),
          envelope_state: envelope,
          international_pending_count: internationalPendingCount,
          low_confidence_count: lowConfidenceCount,
        };
      } catch (err) {
        return handleInternalError(reply, err, "failed to build summary");
      }
    });

    api.get("/context", async (_request, reply) => {
      try {
        const rows = listContext(db).filter(
          (row) => row.key !== "telegram_message_map" && row.key !== "processed_message_ids"
        );
        const flat: Record<string, string | null> = {};
        for (const row of rows) flat[row.key] = row.value;
        return flat;
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch context");
      }
    });

    api.post("/context", async (request, reply) => {
      const body = request.body as { key?: string; value?: string } | undefined;
      if (!body?.key || typeof body.key !== "string" || body.value === undefined || typeof body.value !== "string") {
        return sendError(reply, 400, "Bad request", "'key' and 'value' are required strings");
      }

      try {
        setContext(db, body.key, body.value);
        return { ok: true, key: body.key };
      } catch (err) {
        return handleInternalError(reply, err, "failed to set context");
      }
    });

    api.get("/committed", async (_request, reply) => {
      try {
        return listCommittedExpenses(db);
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch committed expenses");
      }
    });

    api.get("/cards", async (_request, reply) => {
      try {
        const cards = listCreditCards(db);
        return cards.map((card) => {
          const window = getBillingWindow(card, new Date());
          return { ...card, current_window_start: window.start, current_window_end: window.end };
        });
      } catch (err) {
        return handleInternalError(reply, err, "failed to fetch credit cards");
      }
    });

    // MCP endpoint — temporary testing interface for Claude Desktop / other MCP
    // clients that can't reach the plain REST routes (e.g. network restrictions
    // blocking direct fetch). Stateless mode: a fresh McpServer + transport is
    // created per request, since we're only exposing simple request/response
    // tool calls, not resumable sessions or server-initiated notifications.
    const mcpHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();

      const server = buildMcpServer(db);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      reply.raw.on("close", () => {
        transport.close();
        server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        console.error("[mcp] request handling failed:", err);
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    };

    api.post("/mcp", mcpHandler);
    api.get("/mcp", mcpHandler);
  });
}

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (db: Database.Database, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

// Plain-JSON-Schema tool specs for MCP, built via the low-level Server API
// rather than McpServer.registerTool — registerTool's Zod-generic overloads
// caused TypeScript to OOM when instantiated across ~11 distinct shapes in
// one file (a known perf pathology with heavily overloaded generics). This
// also happens to map more directly onto tools.ts's existing JSON Schema
// parameter definitions, so most of these are thin passthroughs.
const MCP_TOOL_NAMES = [
  "create_raw_transaction",
  "bulk_create_raw_transactions",
  "get_raw_transactions",
  "get_salary_profile",
  "update_salary_profile",
  "get_card_cycle_for_date",
  "list_uninterpreted_transactions",
  "infer_raw_transaction",
  "interpret_pending_transactions",
  "create_envelope_entry",
  "list_envelope_entries",
  "get_spend_month_summary",
  "get_funding_summary",
  "set_context_fact",
  "list_context_facts",
  "create_receivable",
  "update_receivable",
  "list_receivables",
  "create_commitment",
  "update_commitment",
  "list_commitments_v2",
] as const;

export function buildMcpToolSpecs(): McpToolSpec[] {
  const specs: McpToolSpec[] = [];

  for (const name of MCP_TOOL_NAMES) {
    const tool = agentTools.find((t) => t.name === name);
    if (!tool) continue;
    specs.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      run: (db, args) => tool.handler(db, args),
    });
  }

  specs.push({
    name: "search_transaction_emails",
    description:
      "Diagnose missing or recent transaction alerts directly in Gmail. Read-only and restricted to configured bank/card senders; returns metadata, parser status, storage status, and parsed transaction fields without full email bodies.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["all", "amex", "bobcard", "idfc", "icici"],
          description: "Restrict the search to one configured card/bank email provider.",
        },
        start_date: {
          type: "string",
          description: "Inclusive IST calendar date in YYYY-MM-DD form. Defaults to two days before today.",
        },
        end_date: {
          type: "string",
          description: "Inclusive IST calendar date in YYYY-MM-DD form. Defaults to today.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of emails to inspect. Defaults to 25.",
        },
      },
      additionalProperties: false,
    },
    run: async (db, args) => {
      try {
        return await searchTransactionEmails(db, args);
      } catch (error) {
        return { status: "error", error: describeGmailDiagnosticError(error) };
      }
    },
  });

  specs.push({
    name: "post_agent_message",
    description: "Send a message to the Plutus finance agent and get its response.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    run: (db, args) => runAgent(db, { user_message: args.message as string, interface: "api" }),
  });

  return specs;
}

function buildMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: "plutus", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
  const specs = buildMcpToolSpecs();
  const specByName = new Map(specs.map((s) => [s.name, s]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = specByName.get(request.params.name);
    if (!spec) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    try {
      const result = await spec.run(db, (request.params.arguments ?? {}) as Record<string, unknown>);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      console.error(`[mcp] tool "${spec.name}" failed:`, err);
      return { content: [{ type: "text", text: "Internal server error" }], isError: true };
    }
  });

  return server;
}

// -- helpers --

function sendError(reply: FastifyReply, status: number, error: string, details?: string): FastifyReply {
  return reply.status(status).send(details ? { error, details } : { error });
}

function handleInternalError(reply: FastifyReply, err: unknown, context: string): FastifyReply {
  console.error(`[api] ${context}:`, err);
  return reply.status(500).send({ error: "Internal server error" });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthStringFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getWeekStartFallback(): Date {
  const today = todayIst();
  const day = today.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const result = new Date(today);
  result.setUTCDate(result.getUTCDate() + diff);
  return result;
}

const rateLimitMap = new Map<string, number[]>();

async function agentRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const ip = request.ip;
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) ?? []).filter((t) => now - t < AGENT_RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= AGENT_RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, timestamps);
    return sendError(reply, 429, "Too many requests");
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return undefined;
}
