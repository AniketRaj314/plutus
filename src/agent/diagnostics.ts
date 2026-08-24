import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { getVioletModelConfig } from "./model-config";

export interface AgentErrorDiagnostic {
  error_ref: string;
  occurred_at: string;
  interface: "telegram" | "api";
  actor_role: "owner" | "contributor";
  stage: string;
  error_type: string;
  status_code: number | null;
  error_code: string | null;
  provider_request_id: string | null;
  safe_message: string;
  model: string;
  reasoning_effort: string;
}

type ProviderLikeError = Error & {
  status?: unknown;
  code?: unknown;
  request_id?: unknown;
  requestId?: unknown;
};

function shortReference(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = nanoid(6).replace(/[^A-Za-z0-9]/g, "X").toUpperCase();
  return `VLT-${date}-${suffix}`;
}

export function sanitizeAgentErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "Unknown agent error";
}

export function recordAgentError(
  db: Database.Database,
  input: {
    interface: "telegram" | "api";
    actor_role: "owner" | "contributor";
    stage: string;
    error: unknown;
    now?: Date;
  }
): AgentErrorDiagnostic {
  const error = input.error as ProviderLikeError;
  const now = input.now ?? new Date();
  const modelConfig = getVioletModelConfig();
  const diagnostic: AgentErrorDiagnostic = {
    error_ref: shortReference(now),
    occurred_at: now.toISOString(),
    interface: input.interface,
    actor_role: input.actor_role,
    stage: input.stage,
    error_type:
      error instanceof Error && error.constructor?.name
        ? error.constructor.name
        : typeof input.error,
    status_code: typeof error?.status === "number" ? error.status : null,
    error_code: typeof error?.code === "string" ? error.code.slice(0, 100) : null,
    provider_request_id:
      typeof error?.request_id === "string"
        ? error.request_id.slice(0, 200)
        : typeof error?.requestId === "string"
          ? error.requestId.slice(0, 200)
          : null,
    safe_message: sanitizeAgentErrorMessage(input.error),
    model: modelConfig.model,
    reasoning_effort: modelConfig.reasoning_effort,
  };

  db.prepare(
    `INSERT INTO agent_error_logs (
      error_ref, occurred_at, interface, actor_role, stage, error_type,
      status_code, error_code, provider_request_id, safe_message, model,
      reasoning_effort
    ) VALUES (
      @error_ref, @occurred_at, @interface, @actor_role, @stage, @error_type,
      @status_code, @error_code, @provider_request_id, @safe_message, @model,
      @reasoning_effort
    )`
  ).run(diagnostic);

  return diagnostic;
}

export function getAgentErrorDiagnostic(
  db: Database.Database,
  errorRef: string
): AgentErrorDiagnostic | undefined {
  return db
    .prepare(
      `SELECT error_ref, occurred_at, interface, actor_role, stage, error_type,
              status_code, error_code, provider_request_id, safe_message, model,
              reasoning_effort
       FROM agent_error_logs
       WHERE error_ref = ?`
    )
    .get(errorRef.trim().toUpperCase()) as AgentErrorDiagnostic | undefined;
}

export function agentErrorLogLine(diagnostic: AgentErrorDiagnostic): string {
  return [
    diagnostic.error_ref,
    diagnostic.stage,
    diagnostic.error_type,
    diagnostic.status_code ?? "no-status",
    diagnostic.safe_message,
  ].join(" | ");
}
