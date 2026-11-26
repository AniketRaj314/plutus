import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getTelegramRecipient } from "../telegram/access";
import {
  createEnvelopeEntry,
  createReceivable,
  getActiveSalaryProfile,
  getRawTransaction,
  insertRawTransaction,
  listEnvelopeEntries,
  setContextFact,
} from "../db/v2-queries";
import { getSalaryFundingMonthForDate } from "../envelope/engine";
import { requireOwner, type OwnerContext } from "./requests";
import { queueSplitMessage } from "./split-outbox";

const money = z.number().int().min(0).max(100_000_000);
export const splitDataSchema = z
  .object({
    title: z.string().max(120),
    date: z.string().nullable(),
    currency: z.string().max(8),
    payer: z.enum(["sender", "aniket", "unknown"]),
    amount_basis: z.enum(["bill_total", "owed_share"]).optional(),
    total_paise: money.nullable(),
    receipt_reference: z.string().max(120).nullable(),
    items: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            amount_paise: money,
            owner_parts: z.number().int().min(0).max(100).nullable(),
            total_parts: z.number().int().min(1).max(100).nullable(),
          })
          .strict(),
      )
      .max(80),
    adjustments: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            amount_paise: z.number().int().min(-100_000_000).max(100_000_000),
          })
          .strict(),
      )
      .max(20),
    unresolved: z.array(z.string().max(200)).max(12),
  })
  .strict();
export type SplitData = z.infer<typeof splitDataSchema>;
export interface SplitDraft {
  id: string;
  contact_id: string;
  user_id: string;
  revision: number;
  status: "draft" | "submitted" | "approved" | "rejected" | "cancelled";
  data: string;
  raw_transaction_id: string | null;
  review_note: string | null;
}
export const emptySplit: SplitData = {
  title: "",
  date: null,
  currency: "INR",
  payer: "unknown",
  total_paise: null,
  receipt_reference: null,
  items: [],
  adjustments: [],
  unresolved: [],
};

export function activeSplit(
  db: Database.Database,
  contactId: string,
): SplitDraft | undefined {
  return db
    .prepare(
      "SELECT * FROM split_drafts WHERE contact_id=? AND status IN ('draft','submitted','rejected')",
    )
    .get(contactId) as SplitDraft | undefined;
}
export function calculateSplit(input: SplitData) {
  const d = splitDataSchema.parse(input);
  if (
    !d.title.trim() ||
    !d.date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
    Number.isNaN(Date.parse(d.date)) ||
    new Date(d.date).toISOString().slice(0, 10) !== d.date
  )
    throw new Error("Confirm the bill name and exact purchase date.");
  if (d.currency !== "INR")
    throw new Error(
      "Aniket needs the settled INR total before this split can be recorded.",
    );
  if (d.payer === "unknown")
    throw new Error("Confirm who paid for this purchase.");
  if (d.unresolved.length) throw new Error(d.unresolved.join(" "));
  if (d.amount_basis === "owed_share") {
    if (!d.total_paise) throw new Error("Confirm the amount owed.");
    if (d.items.length || d.adjustments.length)
      throw new Error(
        "A reported share must not also contain a full bill allocation. Confirm which amount is known.",
      );
    return {
      total_paise: d.total_paise,
      owner_paise: d.payer === "sender" ? d.total_paise : 0,
      sender_paise: d.payer === "aniket" ? d.total_paise : 0,
    };
  }
  if (!d.items.length || !d.total_paise)
    throw new Error("Confirm the items and final amount paid.");
  let subtotal = 0,
    numerator = 0n,
    denominator = 1n;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  for (const item of d.items) {
    if (
      item.owner_parts === null ||
      item.total_parts === null ||
      item.owner_parts > item.total_parts
    )
      throw new Error(`Confirm who shares ${item.name}.`);
    subtotal += item.amount_paise;
    numerator =
      numerator * BigInt(item.total_parts) +
      BigInt(item.amount_paise) * BigInt(item.owner_parts) * denominator;
    denominator *= BigInt(item.total_parts);
    const divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
  }
  if (
    subtotal <= 0 ||
    subtotal + d.adjustments.reduce((s, a) => s + a.amount_paise, 0) !==
      d.total_paise
  )
    throw new Error(
      "The items, charges and discounts do not match the final amount. Please clarify the difference.",
    );
  // Allocate shared fees/discounts proportionally; round once and give the
  // remaining paise to the payer so the two shares exactly equal the bill.
  numerator *= BigInt(d.total_paise);
  denominator *= BigInt(subtotal);
  const beneficiary =
    d.payer === "sender"
      ? numerator
      : BigInt(d.total_paise) * denominator - numerator;
  const owed = Number((2n * beneficiary + denominator) / (2n * denominator));
  if (owed <= 0 || owed > d.total_paise)
    throw new Error("Confirm a positive share for the person who did not pay.");
  const owner = d.payer === "sender" ? owed : d.total_paise - owed;
  return {
    total_paise: d.total_paise,
    owner_paise: owner,
    sender_paise: d.total_paise - owner,
  };
}
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;
export function splitPreview(draft: SplitDraft): string {
  const d = splitDataSchema.parse(JSON.parse(draft.data));
  const sums = calculateSplit(d);
  if (d.amount_basis === "owed_share")
    return `${d.title} · ${d.date}\n${d.payer === "sender" ? "Aniket owes you" : "You owe Aniket"}: ${rupees(sums.total_paise)}\nReported share only; full bill total unknown. No bank movement will be inferred.\nSubject to Aniket's approval.`;
  return (
    `${d.title} · ${d.date}\nPaid by ${d.payer === "sender" ? "the sender" : "Aniket"} · total ${rupees(sums.total_paise)}\n` +
    d.items
      .map(
        (i) =>
          `${i.name}: ${rupees(i.amount_paise)}, Aniket ${i.owner_parts}/${i.total_parts}`,
      )
      .join("\n") +
    (d.adjustments.length
      ? "\n" +
        d.adjustments
          .map((a) => `${a.label}: ${rupees(a.amount_paise)}`)
          .join("\n")
      : "") +
    `\nShared charges/discounts allocated proportionally.\nAniket: ${rupees(sums.owner_paise)} · You: ${rupees(sums.sender_paise)}`
  );
}
export function saveSplit(
  db: Database.Database,
  userId: string,
  data: SplitData,
  evidenceChanged = false,
): SplitDraft {
  return db.transaction(() => {
    const person = getTelegramRecipient(db, userId);
    if (!person || person.delivery_status !== "ready")
      throw new Error("Active private connection required");
    const normalized = JSON.stringify(splitDataSchema.parse(data));
    const prior = activeSplit(db, person.contact_id);
    if (prior?.data === normalized && !evidenceChanged) return prior;
    const at = new Date().toISOString();
    if (prior) {
      db.prepare(
        "UPDATE split_drafts SET data=?,revision=revision+1,status='draft',updated_at=? WHERE id=?",
      ).run(normalized, at, prior.id);
      db.prepare(
        "UPDATE split_outbox SET status='cancelled',error_code='draft_changed' WHERE draft_id=? AND status='queued'",
      ).run(prior.id);
      db.prepare(
        "INSERT INTO split_draft_versions(draft_id,revision,data,created_at) VALUES (?,?,?,?)",
      ).run(prior.id, prior.revision + 1, normalized, at);
      return db
        .prepare("SELECT * FROM split_drafts WHERE id=?")
        .get(prior.id) as SplitDraft;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO split_drafts(id,contact_id,user_id,data,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run(id, person.contact_id, userId, normalized, at, at);
    db.prepare(
      "INSERT INTO split_draft_versions(draft_id,revision,data,created_at) VALUES (?,?,?,?)",
    ).run(id, 1, normalized, at);
    return db
      .prepare("SELECT * FROM split_drafts WHERE id=?")
      .get(id) as SplitDraft;
  })();
}
export function submitSplit(db: Database.Database, draft: SplitDraft) {
  return db.transaction(() => {
    const current = db
      .prepare("SELECT * FROM split_drafts WHERE id=?")
      .get(draft.id) as SplitDraft | undefined;
    if (
      !current ||
      current.revision !== draft.revision ||
      current.data !== draft.data
    )
      throw new Error(
        "That version is no longer current. Review the latest draft.",
      );
    draft = current;
    calculateSplit(JSON.parse(draft.data));
    if (draft.status === "submitted") return;
    if (draft.status !== "draft") throw new Error("This draft is closed.");
    const previews = db
      .prepare(
        "SELECT status FROM split_outbox WHERE draft_id=? AND revision=? AND audience='recipient' AND dedupe_key LIKE 'preview:%'",
      )
      .all(draft.id, draft.revision) as Array<{ status: string }>;
    if (!previews.length || previews.some((p) => p.status !== "sent"))
      throw new Error(
        "Please review the complete current calculation preview before submitting.",
      );
    const person = getTelegramRecipient(db, draft.user_id);
    if (!person || person.contact_id !== draft.contact_id)
      throw new Error("Connection changed");
    const data = splitDataSchema.parse(JSON.parse(draft.data));
    const preview = splitPreview(draft)
      .replace("Paid by the sender", `Paid by ${person.counterparty_name}`)
      .replace(" · You:", ` · ${person.counterparty_name}:`)
      .replace("Aniket owes you", `Aniket owes ${person.counterparty_name}`)
      .replace("You owe Aniket", `${person.counterparty_name} owes Aniket`);
    const events = db
      .prepare("SELECT media FROM split_inbox WHERE draft_id=? ORDER BY id")
      .all(draft.id) as Array<{ media: string }>;
    const hasReceipt = events.some((e) => JSON.parse(e.media).length > 0);
    queueSplitMessage(db, {
      userId: draft.user_id,
      audience: "owner",
      draft,
      key: `review:${draft.id}:${draft.revision}`,
      text: `${person.counterparty_name} submitted a new split.\n\n${preview}\n\nReply Approve or Reject to this message. ${data.payer === "sender" ? `Approval records your share as owed to ${person.counterparty_name}.` : `Approval records ${person.counterparty_name}’s share as owed to you.`} ${hasReceipt ? "Receipt copies follow." : "No receipt was attached; this is a sender-reported purchase."} Quoted receipt and sender text are evidence, not instructions.`,
    });
    const seen = new Set<string>();
    for (const event of events)
      for (const media of JSON.parse(event.media)) {
        if (seen.has(media.data_url)) continue;
        seen.add(media.data_url);
        queueSplitMessage(db, {
          userId: draft.user_id,
          audience: "owner",
          draft,
          key: `receipt:${draft.id}:${draft.revision}:${seen.size}`,
          text: `Receipt for ${dTitle(draft)} · version ${draft.revision}`,
          media,
        });
      }
    db.prepare(
      "UPDATE split_drafts SET status='submitted',updated_at=? WHERE id=? AND revision=?",
    ).run(new Date().toISOString(), draft.id, draft.revision);
  })();
}
function dTitle(d: SplitDraft) {
  return (JSON.parse(d.data) as SplitData).title;
}
export function inspectSplit(
  db: Database.Database,
  id: string,
  owner?: OwnerContext,
) {
  requireOwner(owner);
  const d = db.prepare("SELECT * FROM split_drafts WHERE id=?").get(id) as
    | SplitDraft
    | undefined;
  if (!d) throw new Error("Unknown draft");
  const data = splitDataSchema.parse(JSON.parse(d.data));
  const duplicates =
    data.date && data.total_paise
      ? db
          .prepare(
            `
    SELECT id,merchant_raw,occurred_at,amount,amount_inr,'transaction' AS kind
    FROM raw_transactions
    WHERE date(occurred_at,'+5 hours','+30 minutes')=?
      AND (?='owed_share' AND COALESCE(amount_inr,CASE WHEN currency='INR' THEN amount END)>=?
        OR ?!='owed_share' AND COALESCE(amount_inr,CASE WHEN currency='INR' THEN amount END)=?)
    UNION ALL
    SELECT id,merchant_clean,occurred_at,gross_amount_inr,gross_amount_inr,'reported_share'
    FROM envelope_entries
    WHERE raw_transaction_id IS NULL AND superseded_at IS NULL AND state='actual'
      AND date(occurred_at,'+5 hours','+30 minutes')=? AND created_by LIKE 'owner_approval:%'
  `,
          )
          .all(
            data.date,
            data.amount_basis ?? "bill_total",
            data.total_paise / 100,
            data.amount_basis ?? "bill_total",
            data.total_paise / 100,
            data.date,
          )
      : [];
  return {
    ...d,
    data,
    possible_duplicates: duplicates,
    versions: db
      .prepare(
        "SELECT revision,data,created_at FROM split_draft_versions WHERE draft_id=? ORDER BY revision",
      )
      .all(id),
    deliveries: db
      .prepare(
        "SELECT id,audience,revision,status,error_code FROM split_outbox WHERE draft_id=? ORDER BY rowid",
      )
      .all(id),
    history: db
      .prepare(
        "SELECT text,response,created_at FROM split_inbox WHERE draft_id=? ORDER BY id",
      )
      .all(id),
    receipt_count: (
      db
        .prepare("SELECT media FROM split_inbox WHERE draft_id=?")
        .all(id) as Array<{ media: string }>
    ).reduce((s, e) => s + JSON.parse(e.media).length, 0),
  };
}
export function reviewSplit(
  db: Database.Database,
  input: {
    id: string;
    revision: number;
    action: "approve" | "reject";
    note?: string;
    acknowledge_possible_duplicate?: boolean;
    existing_raw_transaction_id?: string;
  },
  context?: OwnerContext,
) {
  const owner = requireOwner(context);
  if (
    owner.split_review &&
    (owner.split_review.id !== input.id ||
      owner.split_review.revision !== input.revision)
  )
    throw new Error(
      "Approval must refer to the exact version in the owner's reviewed message.",
    );
  return db.transaction(() => {
    const d = db
      .prepare("SELECT * FROM split_drafts WHERE id=?")
      .get(input.id) as SplitDraft | undefined;
    if (!d || d.revision !== input.revision)
      throw new Error(
        "That version is no longer current. Review the latest draft.",
      );
    if (d.status === (input.action === "approve" ? "approved" : "rejected"))
      return d;
    if (d.status !== "submitted")
      throw new Error("The sender must confirm and submit this version first.");
    if (
      owner.split_review &&
      db
        .prepare(
          "SELECT 1 FROM split_outbox WHERE draft_id=? AND revision=? AND audience='owner' AND dedupe_key LIKE 'review:%' AND status!='sent'",
        )
        .get(d.id, d.revision)
    )
      throw new Error(
        "The full review message has not been delivered yet. Inspect the draft and delivery status first.",
      );
    const person = getTelegramRecipient(db, d.user_id);
    if (
      !person ||
      person.contact_id !== d.contact_id ||
      person.delivery_status !== "ready"
    )
      throw new Error("Sender connection is no longer active");
    if (
      db
        .prepare(
          "SELECT 1 FROM split_inbox WHERE contact_id=? AND status IN ('pending','processing','failed')",
        )
        .get(d.contact_id)
    )
      throw new Error(
        "A sender update is still being processed. Review after it finishes.",
      );
    const data = splitDataSchema.parse(JSON.parse(d.data));
    const sums = calculateSplit(data);
    let rawId: string | null = null;
    if (input.action === "approve") {
      const possible = inspectSplit(db, d.id, owner)
        .possible_duplicates as Array<{ id: string; kind: string }>;
      if (
        possible.some(
          (candidate) => candidate.id !== input.existing_raw_transaction_id,
        ) &&
        !input.acknowledge_possible_duplicate
      )
        throw new Error(
          "Possible existing transaction or reported share found. Review possible duplicates and link the existing debit when appropriate before approving.",
        );
      rawId = recordApprovedSplit(
        db,
        d,
        data,
        sums,
        person.counterparty_name,
        owner.actor,
        input.existing_raw_transaction_id,
        input.note,
      );
      setContextFact(db, {
        scope_type: rawId ? "transaction" : "person",
        scope_id: rawId ?? person.counterparty_name,
        key: rawId
          ? "approved_split_receipt"
          : `approved_split_receipt_${d.id}`,
        value: JSON.stringify({
          draft_id: d.id,
          revision: d.revision,
          reporter: person.counterparty_name,
          receipt: data,
          calculation: sums,
          evidence_message_ids: db
            .prepare(
              "SELECT message_id FROM split_inbox WHERE draft_id=? ORDER BY id",
            )
            .all(d.id),
        }),
        source: `owner_approval:${owner.actor}`,
        confidence: 1,
      });
    }
    db.prepare(
      "UPDATE split_drafts SET status=?,raw_transaction_id=?,reviewed_by=?,review_note=?,updated_at=? WHERE id=?",
    ).run(
      input.action === "approve" ? "approved" : "rejected",
      rawId,
      owner.actor,
      input.note ?? null,
      new Date().toISOString(),
      d.id,
    );
    queueSplitMessage(db, {
      userId: d.user_id,
      audience: "recipient",
      draft: d,
      key: `decision:${d.id}:${d.revision}`,
      text:
        input.action === "approve"
          ? `Aniket approved ${data.title} (${data.date}). ${data.payer === "sender" ? `His share of ${rupees(sums.owner_paise)} is now recorded as owed to you.` : `Your share of ${rupees(sums.sender_paise)} is now recorded as owed to him.`}`
          : `Aniket did not approve ${data.title} (${data.date}). Your shared balance has not changed.${input.note ? `\nHis note: ${input.note}` : ""}`,
    });
    return db
      .prepare("SELECT * FROM split_drafts WHERE id=?")
      .get(d.id) as SplitDraft;
  })();
}

// Called only inside reviewSplit's owner-authorized transaction. A share-only
// report is dated economic evidence, not an invented bank transaction.
function recordApprovedSplit(
  db: Database.Database,
  draft: SplitDraft,
  data: SplitData,
  sums: ReturnType<typeof calculateSplit>,
  person: string,
  actor: string,
  existingId?: string,
  note?: string,
): string | null {
  const shareOnly = data.amount_basis === "owed_share";
  const createdBy = `owner_approval:${actor}`;
  const occurredAt = `${data.date}T12:00:00+05:30`;
  const notes = `Owner-approved split ${draft.id}, revision ${draft.revision}. ${shareOnly ? "Reported portion only; full purchase total and bank movement unknown." : "Full reported bill."} ${note ?? ""}`;
  let raw = existingId ? getRawTransaction(db, existingId) : undefined;
  const previous = existingId
    ? listEnvelopeEntries(db, { raw_transaction_id: existingId })
    : [];
  if (existingId) {
    if (data.payer !== "aniket")
      throw new Error(
        "A sender-paid purchase cannot be linked to an owner's bank debit.",
      );
    if (
      !raw ||
      raw.direction !== "debit" ||
      raw.is_reversal ||
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(raw.occurred_at)) !== data.date
    )
      throw new Error(
        "Choose an existing debit on the confirmed purchase date.",
      );
    const amount =
      raw.amount_inr ?? (raw.currency === "INR" ? raw.amount : null);
    if (
      amount === null ||
      (shareOnly
        ? Math.round(amount * 100) < sums.sender_paise
        : Math.round(amount * 100) !== sums.total_paise)
    )
      throw new Error(
        "The existing debit does not match the confirmed amount.",
      );
    const evidence = raw.raw_payload
      ? (() => {
          try {
            return JSON.parse(raw.raw_payload);
          } catch {
            return null;
          }
        })()
      : null;
    if (evidence?.reporter_telegram_user_id && evidence.payer !== "aniket")
      throw new Error(
        "A sender-paid report is not evidence of an owner's bank debit.",
      );
    if (
      previous.length !== 1 ||
      previous[0].state !== "actual" ||
      previous[0].treatment !== "normal" ||
      previous[0].receivable_amount !== 0 ||
      db
        .prepare("SELECT 1 FROM receivables WHERE envelope_entry_id=?")
        .get(previous[0].id) ||
      Math.round(previous[0].personal_impact * 100) !== Math.round(amount * 100)
    )
      throw new Error(
        "This transaction already has a split or special interpretation. Reconcile it before approving this proposal.",
      );
  } else if (!shareOnly) {
    raw = insertRawTransaction(db, {
      source: "manual",
      amount: sums.total_paise / 100,
      amount_inr: sums.total_paise / 100,
      currency: "INR",
      merchant_raw: data.title,
      occurred_at: occurredAt,
      direction: "debit",
      raw_email_id: `approved-split:${draft.id}`,
      raw_payload: JSON.stringify({
        evidence_kind: "owner_approved_recipient_report",
        draft_id: draft.id,
        revision: draft.revision,
        payer: data.payer,
        reporter_telegram_user_id: draft.user_id,
        approved_by: actor,
        amount_basis: "bill_total",
      }),
    });
  }
  const prior = previous[0];
  const ownerPaid = data.payer === "aniket";
  const entry = createEnvelopeEntry(db, {
    raw_transaction_id: raw?.id,
    supersedes_id: prior?.id,
    funding_month:
      prior?.funding_month ??
      getSalaryFundingMonthForDate(
        new Date(occurredAt),
        getActiveSalaryProfile(db)?.salary_day ?? 1,
      ),
    occurred_at: prior?.occurred_at ?? occurredAt,
    source: prior?.source ?? "manual",
    merchant_clean: prior?.merchant_clean ?? data.title,
    category: prior?.category ?? "Other",
    treatment: "normal",
    state: "actual",
    gross_amount_inr: prior?.gross_amount_inr ?? sums.total_paise / 100,
    personal_impact: prior
      ? (Math.round(prior.personal_impact * 100) - sums.sender_paise) / 100
      : sums.owner_paise / 100,
    cashflow_impact:
      prior?.cashflow_impact ??
      (ownerPaid && !shareOnly ? sums.total_paise / 100 : 0),
    receivable_amount: ownerPaid ? sums.sender_paise / 100 : 0,
    notes,
    confidence: 1,
    created_by: createdBy,
  });
  if (ownerPaid)
    createReceivable(db, {
      envelope_entry_id: entry.id,
      counterparty: person,
      label: data.title,
      amount_inr: sums.sender_paise / 100,
      notes,
      created_by: createdBy,
    });
  else
    setContextFact(db, {
      scope_type: "person",
      scope_id: person,
      key: `counterparty_payable_${raw?.id ?? draft.id}`,
      value: JSON.stringify({
        status: "outstanding",
        label: data.title,
        amount_owed_inr: sums.owner_paise / 100,
        occurred_at: occurredAt,
        raw_transaction_id: raw?.id ?? null,
        envelope_entry_id: entry.id,
        reported_by: person,
        reporter_telegram_user_id: draft.user_id,
        notes,
      }),
      source: createdBy,
      confidence: 1,
    });
  return raw?.id ?? null;
}
