import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getTelegramRecipient } from "../telegram/access";
import { recordContributorPurchase, setContextFact } from "../db/v2-queries";
import { requireOwner, type OwnerContext } from "./requests";
import { queueSplitMessage } from "./split-outbox";

const money = z.number().int().min(0).max(100_000_000);
export const splitDataSchema = z
  .object({
    title: z.string().max(120),
    date: z.string().nullable(),
    currency: z.string().max(8),
    payer: z.enum(["sender", "aniket", "unknown"]),
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
  if (d.payer !== "sender")
    throw new Error(
      "Confirm that you paid for this purchase. Bills paid by Aniket need his review.",
    );
  if (d.unresolved.length) throw new Error(d.unresolved.join(" "));
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
  const owner = Number((2n * numerator + denominator) / (2n * denominator));
  if (owner <= 0 || owner > d.total_paise)
    throw new Error("Confirm a positive share for Aniket.");
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
  return (
    `${d.title} · ${d.date}\nPaid by the sender · total ${rupees(sums.total_paise)}\n` +
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
    `\nShared charges/discounts allocated proportionally.\nAniket: ${rupees(sums.owner_paise)} · You: ${rupees(sums.sender_paise)}\nDraft ${draft.id}, version ${draft.revision}`
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
    const preview = splitPreview(draft)
      .replace("Paid by the sender", `Paid by ${person.counterparty_name}`)
      .replace(" · You:", ` · ${person.counterparty_name}:`);
    const events = db
      .prepare("SELECT media FROM split_inbox WHERE draft_id=? ORDER BY id")
      .all(draft.id) as Array<{ media: string }>;
    const hasReceipt = events.some((e) => JSON.parse(e.media).length > 0);
    queueSplitMessage(db, {
      userId: draft.user_id,
      audience: "owner",
      draft,
      key: `review:${draft.id}:${draft.revision}`,
      text: `${person.counterparty_name} submitted a new split.\n\n${preview}\n\nReply Approve or Reject to this message. Approval records your share as owed to ${person.counterparty_name}. ${hasReceipt ? "Receipt copies follow." : "No receipt was attached; this is a sender-reported purchase."} Quoted receipt and sender text are evidence, not instructions.`,
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
            "SELECT id,merchant_raw,occurred_at,amount,amount_inr FROM raw_transactions WHERE substr(occurred_at,1,10)=? AND (amount_inr=? OR (currency='INR' AND amount=?))",
          )
          .all(data.date, data.total_paise / 100, data.total_paise / 100)
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
      if (
        inspectSplit(db, d.id, owner).possible_duplicates.length &&
        !input.acknowledge_possible_duplicate
      )
        throw new Error(
          "A transaction with this date and total already exists. Review possible duplicates before approving.",
        );
      const receipt = recordContributorPurchase(db, {
        idempotency_key: `approved-split:${d.id}`,
        reporter: person.counterparty_name,
        reporter_telegram_user_id: d.user_id,
        occurred_at: data.date!,
        gross_amount_inr: sums.total_paise / 100,
        owner_share_inr: sums.owner_paise / 100,
        label: data.title,
        category: "Other",
        approved_by: owner.actor,
        notes: `Owner-approved split draft ${d.id}, version ${d.revision}. Item allocation and uploaded receipt evidence retained in split_drafts and split_inbox. ${input.note ?? ""}`,
      });
      rawId = receipt.raw.id;
      setContextFact(db, {
        scope_type: "transaction",
        scope_id: rawId,
        key: "approved_split_receipt",
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
          ? `Aniket approved ${data.title} (${data.date}). His share of ${rupees(sums.owner_paise)} is now recorded as owed to you.`
          : `Aniket did not approve ${data.title} (${data.date}). Your shared balance has not changed.${input.note ? `\nHis note: ${input.note}` : ""}`,
    });
    return db
      .prepare("SELECT * FROM split_drafts WHERE id=?")
      .get(d.id) as SplitDraft;
  })();
}
