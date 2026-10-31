import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { findContact } from "../contacts/store";
import {
  getCounterpartyBalance,
  getEnvelopeEntry,
  listReceivables,
} from "../db/v2-queries";
import type { TelegramContributor } from "../telegram/access";

export interface OwnerContext {
  role: "owner";
  actor: string;
  source: "telegram" | "api" | "mcp";
  request_id: string;
  // Trusted turn-local scope, populated by the owner agent and Telegram routing.
  bill_ids?: string[];
  owner_message_id?: number;
}

export function requireOwner(context?: OwnerContext): OwnerContext {
  if (
    !context ||
    context.role !== "owner" ||
    !context.actor ||
    !context.request_id
  ) {
    throw new Error("An authenticated interactive owner action is required");
  }
  return context;
}

export type RequestBasis = "split" | "net_balance";
export type RequestStatus =
  | "draft"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "stale"
  | "cancelled";
export interface PaymentRequest {
  id: string;
  batch_id: string;
  contact_id: string;
  dedupe_key: string;
  basis: RequestBasis;
  source_ids: string;
  context: string;
  amount_paise: number;
  snapshot: string;
  fingerprint: string;
  message: string;
  status: RequestStatus;
  authorized_by: string | null;
  authorized_at: string | null;
  expires_at: string;
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  telegram_message_id: number | null;
  sent_at: string | null;
  last_error_code: string | null;
}
export interface RequestInput {
  contact_id: string;
  receivable_ids: string[];
  context: string;
  basis?: RequestBasis;
}
export interface MessageFacts {
  name: string;
  context: string;
  summary?: string;
  amount_paise: number;
  basis: RequestBasis;
  upi: string;
}
export type ComposeMessage = (facts: MessageFacts) => Promise<string>;

export function paymentDestination(): string {
  const upi = process.env.PAYMENT_REQUEST_UPI_ID?.trim() || "9969596700@ptyes";
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/.test(upi))
    throw new Error("Invalid payment destination configuration");
  return upi;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function paise(amount: number): number {
  const value = Math.round(amount * 100);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid monetary amount");
  return value;
}

function evidenceWindow(value: string | null): [number, number] {
  if (!value) return [NaN, NaN];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00+05:30`);
    return [start, start + 86400000 - 1];
  }
  // SQLite's created_at defaults are UTC; explicit alert offsets are preserved.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  const at = Date.parse(normalized);
  return [at, at];
}

export function requestSnapshot(db: Database.Database, input: RequestInput) {
  const contact = findContact(db, input.contact_id);
  if (!contact || contact.id !== input.contact_id)
    throw new Error("Use an existing canonical contact ID");
  if (
    !Array.isArray(input.receivable_ids) ||
    input.receivable_ids.length > 50 ||
    input.receivable_ids.some((id) => typeof id !== "string")
  )
    throw new Error("Invalid receivable selection");
  const basis = input.basis ?? "split";
  if (!["split", "net_balance"].includes(basis))
    throw new Error("Invalid request basis");
  const sourceIds = [...new Set(input.receivable_ids)].sort();
  if (basis === "split" && !sourceIds.length)
    throw new Error("Select the confirmed split receivables");
  const balance = getCounterpartyBalance(db, contact.id, { view: "full" });
  if (balance.uncertain.length)
    throw new Error(
      "Resolve uncertain shared-tab items before requesting payment",
    );
  const receivables = listReceivables(db, {
    counterparty: contact.id,
    include_closed: true,
  });
  if (basis === "net_balance") {
    for (const row of receivables.filter((r) =>
      balance.value_from_user.some((v) => v.source_id === r.id),
    )) {
      const entry = row.envelope_entry_id
        ? getEnvelopeEntry(db, row.envelope_entry_id)
        : undefined;
      if (
        row.envelope_entry_id &&
        (!entry ||
          entry.superseded_at ||
          ["cancelled", "forecast"].includes(entry.state))
      ) {
        throw new Error(
          "Reconcile inactive split interpretations before requesting a net balance",
        );
      }
    }
  }
  const selected = sourceIds.map((id) => {
    const row = receivables.find((r) => r.id === id);
    if (!row)
      throw new Error("A selected receivable does not belong to this contact");
    if (row.status !== "pending" || row.received_inr !== 0)
      throw new Error(
        "Selected split has receipt or closure information; review payment basis",
      );
    if (!balance.value_from_user.some((v) => v.source_id === id))
      throw new Error("Selected split is excluded or unconfirmed");
    if (row.envelope_entry_id) {
      const entry = getEnvelopeEntry(db, row.envelope_entry_id);
      if (
        !entry ||
        entry.superseded_at ||
        entry.state === "cancelled" ||
        entry.state === "forecast"
      )
        throw new Error("Split interpretation is no longer active");
    }
    return {
      id: row.id,
      label: row.label,
      amount_paise: paise(row.amount_inr),
      updated_at: row.updated_at,
      entry_id: row.envelope_entry_id,
      status: row.status,
    };
  });
  const amount =
    basis === "split"
      ? selected.reduce((sum, r) => sum + r.amount_paise, 0)
      : paise(balance.net_balance_inr);
  if (amount <= 0 || !Number.isSafeInteger(amount))
    throw new Error("There is no positive confirmed amount to request");
  if (basis === "split") {
    const earliest = Math.min(
      ...balance.value_from_user
        .filter((v) => sourceIds.includes(v.source_id))
        .map((v) => evidenceWindow(v.occurred_at)[0]),
    );
    if (
      paise(balance.net_balance_inr) < amount ||
      balance.value_from_counterparty.some(
        (v) =>
          !Number.isFinite(earliest) ||
          !Number.isFinite(evidenceWindow(v.occurred_at)[1]) ||
          evidenceWindow(v.occurred_at)[1] >= earliest,
      )
    ) {
      throw new Error(
        "Repayments or offsets may cover this split. Ask Aniket whether to request the current net balance instead",
      );
    }
  }
  const connection = db
    .prepare("SELECT * FROM telegram_contributors WHERE contact_id = ?")
    .get(contact.id) as TelegramContributor | undefined;
  const compact = (rows: typeof balance.value_from_user) =>
    rows
      .map((v) => ({
        id: v.source_id,
        amount: paise(v.amount_inr),
        kind: v.kind,
        date: v.occurred_at,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return {
    contact: {
      id: contact.id,
      name: contact.display_name,
      version: contact.version,
    },
    connection: connection
      ? {
          user_id: connection.telegram_user_id,
          chat_id: connection.private_chat_id,
          status: connection.status,
          role: connection.role,
          delivery_status: connection.delivery_status,
        }
      : null,
    basis,
    selected,
    amount_paise: amount,
    upi: paymentDestination(),
    ledger: {
      net_paise: paise(balance.net_balance_inr),
      from_owner: compact(balance.value_from_user),
      from_contact: compact(balance.value_from_counterparty),
      receipts: receivables
        .map((r) => ({
          id: r.id,
          status: r.status,
          received: paise(r.received_inr),
          amount: paise(r.amount_inr),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

export function getPaymentRequest(
  db: Database.Database,
  id: string,
): PaymentRequest {
  const row = db
    .prepare("SELECT * FROM payment_requests WHERE id = ?")
    .get(id) as PaymentRequest | undefined;
  if (!row) throw new Error("Payment request not found");
  return row;
}

export function auditRequest(
  db: Database.Database,
  id: string,
  action: string,
  actor: string,
  now = new Date(),
): void {
  db.prepare(
    "INSERT INTO payment_audit(request_id,action,actor,created_at) VALUES (?,?,?,?)",
  ).run(id, action, actor, now.toISOString());
}

export function currentFingerprint(
  db: Database.Database,
  row: PaymentRequest,
): string {
  return hash({
    snapshot: requestSnapshot(db, {
      contact_id: row.contact_id,
      receivable_ids: JSON.parse(row.source_ids),
      basis: row.basis,
      context: row.context,
    }),
    context: row.context,
  });
}

function assertNotAlreadyRequested(
  db: Database.Database,
  snapshot: ReturnType<typeof requestSnapshot>,
  exceptId?: string,
): void {
  const sourceIds = new Set(
    snapshot.basis === "split"
      ? snapshot.selected.map((r) => r.id)
      : snapshot.ledger.from_owner.map((r) => r.id),
  );
  const outstanding = db
    .prepare(
      "SELECT * FROM payment_requests WHERE contact_id=? AND status IN ('queued','sending','sent','uncertain')",
    )
    .all(snapshot.contact.id) as PaymentRequest[];
  for (const request of outstanding) {
    if (request.id === exceptId) continue;
    const previous = JSON.parse(request.snapshot) as ReturnType<
      typeof requestSnapshot
    >;
    const previousIds =
      previous.basis === "split"
        ? previous.selected.map((r) => r.id)
        : previous.ledger.from_owner.map((r) => r.id);
    if (previousIds.some((id) => sourceIds.has(id)))
      throw new Error(
        "These obligations overlap an already queued, sent, or uncertain request. Review existing requests; do not send another demand for the same split",
      );
  }
}

export async function preparePaymentBatch(
  db: Database.Database,
  inputs: RequestInput[],
  context: OwnerContext,
  compose: ComposeMessage,
  now = new Date(),
) {
  const owner = requireOwner(context);
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20)
    throw new Error("Prepare 1-20 recipients at a time");
  if (new Set(inputs.map((i) => i.contact_id)).size !== inputs.length)
    throw new Error("Combine a person's selected splits into one request");
  const batchId = randomUUID();
  db.prepare(
    "INSERT INTO payment_batches(id,created_by,created_at) VALUES (?,?,?)",
  ).run(batchId, owner.actor, now.toISOString());
  const results: Array<{
    contact_id: string;
    request_id?: string;
    error?: string;
  }> = [];
  for (const input of inputs) {
    try {
      if (
        typeof input.context !== "string" ||
        !input.context.trim() ||
        input.context.length > 400
      )
        throw new Error(
          "Supply a short, shareable split description (up to 400 characters)",
        );
      const snapshot = requestSnapshot(db, input);
      const sourceIds = [...new Set(input.receivable_ids)].sort();
      const dedupe = hash([
        input.contact_id,
        snapshot.basis,
        snapshot.basis === "split" ? sourceIds : snapshot.ledger,
      ]);
      const existing = db
        .prepare("SELECT * FROM payment_requests WHERE dedupe_key = ?")
        .get(dedupe) as PaymentRequest | undefined;
      const fingerprint = hash({ snapshot, context: input.context });
      if (
        existing &&
        (["sent", "sending", "queued", "uncertain"].includes(existing.status) ||
          (existing.status === "draft" &&
            existing.fingerprint === fingerprint &&
            existing.expires_at > now.toISOString()))
      ) {
        db.prepare(
          "INSERT INTO payment_batch_items(batch_id,request_id) VALUES (?,?)",
        ).run(batchId, existing.id);
        results.push({ contact_id: input.contact_id, request_id: existing.id });
        continue;
      }
      assertNotAlreadyRequested(db, snapshot, existing?.id);
      const message = await compose({
        name: snapshot.contact.name,
        context: input.context,
        summary:
          input.context.length <= 140
            ? input.context
            : snapshot.basis === "split"
              ? [...new Set(snapshot.selected.map((row) => row.label))]
                  .join(", ")
                  .slice(0, 140)
              : "your shared tab with Aniket",
        amount_paise: snapshot.amount_paise,
        basis: snapshot.basis,
        upi: snapshot.upi,
      });
      if (!message || message.length > 2500)
        throw new Error(
          "Generated payment message exceeds the single-message limit",
        );
      const id = existing?.id ?? randomUUID();
      db.transaction(() => {
        const rechecked = hash({
          snapshot: requestSnapshot(db, input),
          context: input.context,
        });
        if (rechecked !== fingerprint)
          throw new Error(
            "Financial or contact details changed during preparation; prepare again",
          );
        assertNotAlreadyRequested(db, snapshot, existing?.id);
        if (existing) {
          const result = db
            .prepare(
              `UPDATE payment_requests SET snapshot=?, fingerprint=?, message=?, context=?, amount_paise=?, status='draft',
            expires_at=?, authorized_by=NULL, authorized_at=NULL, last_error_code=NULL, next_attempt_at=NULL
            WHERE id=? AND status IN ('draft','failed','stale','cancelled')`,
            )
            .run(
              JSON.stringify(snapshot),
              fingerprint,
              message,
              input.context,
              snapshot.amount_paise,
              new Date(now.getTime() + 86400000).toISOString(),
              id,
            );
          if (!result.changes)
            throw new Error(
              "Request changed concurrently; read its current status",
            );
        } else {
          db.prepare(
            `INSERT INTO payment_requests(id,batch_id,contact_id,dedupe_key,basis,source_ids,context,amount_paise,snapshot,fingerprint,message,status,expires_at,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
          ).run(
            id,
            batchId,
            input.contact_id,
            dedupe,
            snapshot.basis,
            JSON.stringify(sourceIds),
            input.context,
            snapshot.amount_paise,
            JSON.stringify(snapshot),
            fingerprint,
            message,
            new Date(now.getTime() + 86400000).toISOString(),
            now.toISOString(),
          );
        }
        db.prepare(
          `INSERT INTO payment_request_qr(request_id,fingerprint,status,next_attempt_at) VALUES (?,?,'waiting',?)
           ON CONFLICT(request_id) DO UPDATE SET fingerprint=excluded.fingerprint,status='waiting',attempts=0,
             next_attempt_at=excluded.next_attempt_at,lease_until=NULL,telegram_message_id=NULL,sent_at=NULL,last_error_code=NULL`,
        ).run(id, fingerprint, now.toISOString());
        db.prepare(
          "INSERT INTO payment_batch_items(batch_id,request_id) VALUES (?,?)",
        ).run(batchId, id);
        auditRequest(db, id, "prepared", owner.actor, now);
      })();
      results.push({ contact_id: input.contact_id, request_id: id });
    } catch (error) {
      results.push({
        contact_id: input.contact_id,
        error: error instanceof Error ? error.message : "Preparation failed",
      });
    }
  }
  return {
    batch_id: batchId,
    results,
    requests: listPaymentRequests(db, batchId),
  };
}

export function listPaymentRequests(db: Database.Database, batchId?: string) {
  const rows = (
    batchId
      ? db
          .prepare(
            `SELECT p.* FROM payment_requests p JOIN payment_batch_items b ON p.id=b.request_id WHERE b.batch_id=? ORDER BY p.created_at`,
          )
          .all(batchId)
      : db
          .prepare(
            "SELECT * FROM payment_requests ORDER BY created_at DESC LIMIT 100",
          )
          .all()
  ) as PaymentRequest[];
  return rows.map((row) => ({
    id: row.id,
    contact_id: row.contact_id,
    name: findContact(db, row.contact_id)?.display_name,
    basis: row.basis,
    amount_inr: row.amount_paise / 100,
    context: row.context,
    message: row.message,
    fingerprint: row.fingerprint,
    status: row.status,
    qr:
      db
        .prepare(
          "SELECT status,telegram_message_id,last_error_code FROM payment_request_qr WHERE request_id=?",
        )
        .get(row.id) ?? null,
    error_code: row.last_error_code,
    expires_at: row.expires_at,
    connected: Boolean(
      db
        .prepare(
          "SELECT 1 FROM telegram_contributors WHERE contact_id=? AND status='active' AND private_chat_id IS NOT NULL",
        )
        .get(row.contact_id),
    ),
    reply_count: (
      db
        .prepare("SELECT COUNT(*) AS n FROM payment_replies WHERE request_id=?")
        .get(row.id) as { n: number }
    ).n,
  }));
}

export function authorizePaymentRequests(
  db: Database.Database,
  selections: Array<{ id: string; fingerprint: string }>,
  context: OwnerContext,
  now = new Date(),
) {
  const owner = requireOwner(context);
  if (
    !Array.isArray(selections) ||
    !selections.length ||
    selections.length > 20
  )
    throw new Error("Select 1-20 prepared requests");
  return selections.map((selection) => {
    try {
      return db.transaction(() => {
        const row = getPaymentRequest(db, selection.id);
        if (["sent", "queued", "sending"].includes(row.status))
          return { id: row.id, status: row.status };
        if (row.status !== "draft")
          return {
            id: row.id,
            status: row.status,
            error: "Prepare again or explicitly resolve uncertain delivery",
          };
        try {
          if (
            row.expires_at <= now.toISOString() ||
            selection.fingerprint !== row.fingerprint ||
            currentFingerprint(db, row) !== row.fingerprint
          )
            throw new Error("stale");
          const snapshot = JSON.parse(row.snapshot);
          assertNotAlreadyRequested(db, snapshot, row.id);
          if (
            !snapshot.connection ||
            snapshot.connection.status !== "active" ||
            snapshot.connection.delivery_status !== "ready"
          )
            return {
              id: row.id,
              status: "needs_connection",
              error:
                "Contact must connect and allow requests; prepare again afterward",
            };
          db.prepare(
            "UPDATE payment_requests SET status='queued',authorized_by=?,authorized_at=?,next_attempt_at=? WHERE id=? AND status='draft'",
          ).run(
            `${owner.actor}:${owner.request_id}`,
            now.toISOString(),
            now.toISOString(),
            row.id,
          );
          auditRequest(
            db,
            row.id,
            "authorized",
            `${owner.actor}:${owner.request_id}`,
            now,
          );
          return {
            id: row.id,
            status: "queued",
            delivery_enabled:
              process.env.PAYMENT_REQUEST_DELIVERY_ENABLED === "true",
          };
        } catch {
          db.prepare(
            "UPDATE payment_requests SET status='stale',last_error_code='details_changed' WHERE id=?",
          ).run(row.id);
          return {
            id: row.id,
            status: "stale",
            error: "Details changed or authorization expired; prepare again",
          };
        }
      })();
    } catch (error) {
      return {
        id: selection.id,
        status: "error",
        error: error instanceof Error ? error.message : "Authorization failed",
      };
    }
  });
}

export function changeRequestState(
  db: Database.Database,
  id: string,
  action: "cancel" | "retry_uncertain",
  fingerprint: string | undefined,
  context: OwnerContext,
  now = new Date(),
) {
  const owner = requireOwner(context);
  return db.transaction(() => {
    const row = getPaymentRequest(db, id);
    if (action === "cancel") {
      if (["sending", "sent", "uncertain"].includes(row.status))
        throw new Error(
          "Cannot cancel a message that may already have been sent",
        );
      db.prepare(
        "UPDATE payment_requests SET status='cancelled' WHERE id=?",
      ).run(id);
      db.prepare(
        "UPDATE payment_request_qr SET status='cancelled' WHERE request_id=? AND status IN ('waiting','queued')",
      ).run(id);
    } else if (action === "retry_uncertain") {
      if (row.status !== "uncertain")
        throw new Error("Only uncertain delivery can use this action");
      if (
        fingerprint !== row.fingerprint ||
        currentFingerprint(db, row) !== row.fingerprint
      )
        throw new Error("Details changed; do not resend the old request");
      db.prepare(
        "UPDATE payment_requests SET status='queued',authorized_by=?,authorized_at=?,expires_at=?,next_attempt_at=?,lease_until=NULL WHERE id=?",
      ).run(
        `${owner.actor}:${owner.request_id}`,
        now.toISOString(),
        new Date(now.getTime() + 86400000).toISOString(),
        now.toISOString(),
        id,
      );
    } else throw new Error("Invalid request action");
    auditRequest(db, id, action, `${owner.actor}:${owner.request_id}`, now);
    return { id, status: getPaymentRequest(db, id).status };
  })();
}
