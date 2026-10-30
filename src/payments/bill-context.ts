import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  requireOwner,
  type OwnerContext,
  type PaymentRequest,
} from "./requests";

// Stable identities survive replacement of an interpretation. Raw bank evidence is never modified.
export function billIds(db: Database.Database, reference: string): string[] {
  const request = db
    .prepare("SELECT source_ids FROM payment_requests WHERE id=?")
    .get(reference) as { source_ids: string } | undefined;
  if (request)
    return [
      ...new Set(
        (JSON.parse(request.source_ids) as string[]).flatMap((id) =>
          billIds(db, id),
        ),
      ),
    ];
  const receivable = db
    .prepare("SELECT envelope_entry_id FROM receivables WHERE id=?")
    .get(reference) as { envelope_entry_id: string | null } | undefined;
  if (receivable)
    return receivable.envelope_entry_id
      ? billIds(db, receivable.envelope_entry_id)
      : [`receivable:${reference}`];
  let entry = db
    .prepare(
      "SELECT id,raw_transaction_id,supersedes_id FROM envelope_entries WHERE id=?",
    )
    .get(reference) as
    | {
        id: string;
        raw_transaction_id: string | null;
        supersedes_id: string | null;
      }
    | undefined;
  const seen = new Set<string>();
  while (entry) {
    if (entry.raw_transaction_id) return [`raw:${entry.raw_transaction_id}`];
    if (!entry.supersedes_id || seen.has(entry.id))
      return [`entry:${entry.id}`];
    seen.add(entry.id);
    entry = db
      .prepare(
        "SELECT id,raw_transaction_id,supersedes_id FROM envelope_entries WHERE id=?",
      )
      .get(entry.supersedes_id) as typeof entry;
  }
  if (db.prepare("SELECT 1 FROM raw_transactions WHERE id=?").get(reference))
    return [`raw:${reference}`];
  throw new Error(
    "Unknown bill reference; use a raw transaction, entry, receivable, or payment request ID",
  );
}

function billEntries(
  db: Database.Database,
  bill: string,
): Array<{ id: string }> {
  if (bill.startsWith("raw:"))
    return db
      .prepare(
        "SELECT id FROM envelope_entries WHERE raw_transaction_id=? ORDER BY id",
      )
      .all(bill.slice(4)) as Array<{ id: string }>;
  if (bill.startsWith("entry:"))
    return db
      .prepare(
        `WITH RECURSIVE versions(id) AS (
    SELECT id FROM envelope_entries WHERE id=? UNION SELECT e.id FROM envelope_entries e JOIN versions v ON e.supersedes_id=v.id
  ) SELECT id FROM versions ORDER BY id`,
      )
      .all(bill.slice(6)) as Array<{ id: string }>;
  return [];
}

export function billRevision(db: Database.Database, bill: string): string {
  const entries = billEntries(db, bill).map((e) =>
    db.prepare("SELECT * FROM envelope_entries WHERE id=?").get(e.id),
  );
  const receivables = bill.startsWith("receivable:")
    ? [db.prepare("SELECT * FROM receivables WHERE id=?").get(bill.slice(11))]
    : billEntries(db, bill).flatMap((e) =>
        db
          .prepare(
            "SELECT * FROM receivables WHERE envelope_entry_id=? ORDER BY id",
          )
          .all(e.id),
      );
  return createHash("sha256")
    .update(JSON.stringify({ entries, receivables }))
    .digest("hex");
}

export function linkOwnerMessages(
  db: Database.Database,
  bills: string[],
  ids: number[],
): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO bill_owner_messages(bill_id,message_id) VALUES (?,?)",
  );
  db.transaction(() => {
    for (const bill of bills) for (const id of ids) insert.run(bill, id);
  })();
}

export function getBillContext(
  db: Database.Database,
  reference: string,
  context?: OwnerContext,
) {
  const owner = requireOwner(context);
  const bills = billIds(db, reference);
  owner.bill_ids = [...new Set([...(owner.bill_ids ?? []), ...bills])];
  if (owner.owner_message_id)
    linkOwnerMessages(db, bills, [owner.owner_message_id]);
  return bills.map((bill) => {
    // Historical imports require an exact transaction marker, never a fuzzy name match.
    if (bill.startsWith("raw:")) {
      const rawId = bill.slice(4);
      const matches = db
        .prepare(
          "SELECT id,content FROM agent_messages WHERE role='user' AND instr(content,?)>0",
        )
        .all(`raw_transaction_id=${rawId}]`) as Array<{
        id: number;
        content: string;
      }>;
      for (const row of matches) {
        const next = db
          .prepare(
            "SELECT id,role FROM agent_messages WHERE id>? ORDER BY id LIMIT 1",
          )
          .get(row.id) as { id: number; role: string } | undefined;
        linkOwnerMessages(
          db,
          [bill],
          [row.id, ...(next?.role === "assistant" ? [next.id] : [])],
        );
      }
    }
    return {
      bill_id: bill,
      revision: billRevision(db, bill),
      owner_only_history: db
        .prepare(
          `SELECT a.id,a.role,a.content,a.created_at FROM agent_messages a JOIN bill_owner_messages b ON b.message_id=a.id
        WHERE b.bill_id=? ORDER BY a.id DESC LIMIT 80`,
        )
        .all(bill)
        .reverse(),
      entries: billEntries(db, bill).map((e) =>
        db.prepare("SELECT * FROM envelope_entries WHERE id=?").get(e.id),
      ),
      receivables: bill.startsWith("receivable:")
        ? [
            db
              .prepare("SELECT * FROM receivables WHERE id=?")
              .get(bill.slice(11)),
          ]
        : billEntries(db, bill).flatMap((e) =>
            db
              .prepare(
                "SELECT * FROM receivables WHERE envelope_entry_id=? ORDER BY id",
              )
              .all(e.id),
          ),
      receipt_facts: bill.startsWith("raw:")
        ? db
            .prepare(
              "SELECT key,value FROM context_facts WHERE scope_type='transaction' AND scope_id=? AND superseded_at IS NULL",
            )
            .all(bill.slice(4))
        : [],
      explanations: db
        .prepare("SELECT * FROM bill_explanations WHERE bill_id=?")
        .all(bill),
    };
  });
}

export function saveBillExplanation(
  db: Database.Database,
  input: {
    reference_id: string;
    contact_id: string;
    explanation: string;
    state: "confirmed" | "tentative" | "private";
    source_message_ids: number[];
  },
  context?: OwnerContext,
) {
  const owner = requireOwner(context);
  const bills = billIds(db, input.reference_id);
  if (bills.length !== 1)
    throw new Error("Publish an explanation for one bill at a time");
  const bill = bills[0];
  if (owner.owner_message_id)
    linkOwnerMessages(db, [bill], [owner.owner_message_id]);
  if (!db.prepare("SELECT 1 FROM contacts WHERE id=?").get(input.contact_id))
    throw new Error("Unknown contact");
  for (const id of input.source_message_ids) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM bill_owner_messages WHERE bill_id=? AND message_id=?",
        )
        .get(bill, id)
    )
      throw new Error(
        "Explanation source must belong to this bill's owner discussion",
      );
  }
  db.prepare(
    `INSERT INTO bill_explanations(bill_id,contact_id,explanation,state,revision,source_message_ids,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(bill_id,contact_id) DO UPDATE SET explanation=excluded.explanation,state=excluded.state,
    revision=excluded.revision,source_message_ids=excluded.source_message_ids,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
  ).run(
    bill,
    input.contact_id,
    input.explanation,
    input.state,
    billRevision(db, bill),
    JSON.stringify(input.source_message_ids),
    owner.actor,
    new Date().toISOString(),
  );
  owner.bill_ids = [...new Set([...(owner.bill_ids ?? []), bill])];
  return { bill_id: bill, contact_id: input.contact_id, state: input.state };
}

export function recipientBillExplanations(
  db: Database.Database,
  request: PaymentRequest,
) {
  return billIds(db, request.id).map((bill) => {
    const row = db
      .prepare(
        "SELECT explanation,revision FROM bill_explanations WHERE bill_id=? AND contact_id=? AND state='confirmed'",
      )
      .get(bill, request.contact_id) as
      | { explanation: string; revision: string }
      | undefined;
    return {
      bill_id: bill,
      explanation:
        row && row.revision === billRevision(db, bill) ? row.explanation : null,
      needs_owner_review: !row || row.revision !== billRevision(db, bill),
    };
  });
}
