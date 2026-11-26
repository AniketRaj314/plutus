# Recipient split drafts, version 1.18.0

A friend can describe a new expense, upload a receipt in a separate message,
clarify who paid and who had which items, then confirm a calculation preview.
The bill-selection menu no longer intercepts receipt loading or traps someone
who says this is a new split. Old-bill questions still use the existing scoped
recipient assistant and owner notification loop.

The receipt reader proposes structured facts. Code validates dates, totals,
allocations and currency and calculates the two shares with integer/rational
arithmetic. Item amounts are line totals including quantity. Shared fees,
discounts and taxes are allocated proportionally to item subtotals; rounding
occurs once and the remaining paise stays with the payer. Exceptions need
clarification. Unreadable evidence is never converted into invented facts.

## Confirmation and approval

1. Violet retains the explanation and uploads in the private contact inbox.
2. Once the details reconcile, she sends a preview with the date, payer, items,
   adjustments, both shares. The server retains the exact revision for confirmation.
3. The sender confirms that delivered preview to submit it. This queues Aniket's
   review, itemisation and receipt copies. Missing receipts are clearly labelled.
4. Aniket can reply `Approve` or `Reject` to the review message. More detailed
   discussion uses the owner assistant's `inspect_split_draft` and
   `review_split_draft` tools. Rejection notes are explicitly shared with the sender.
5. Only approval writes the economic expense and bilateral debt, atomically
   with the approved state and the sender's decision notification. It records the
   source as an owner-approved recipient report. A repeated approval is idempotent.
   The structured receipt and allocation are linked to the resulting transaction
   and available through the existing bill-context tools.

Pending incoming corrections, unsubmitted versions, changed permissions and
stale approval messages block the write. Explicitly approving a different draft
through a reply to an old review is disallowed. Same-date/same-total ledger
candidates require owner duplicate review. A rejection keeps the draft and its
receipts available for correction and resubmission. Cancellation closes it.
Previously approved purchases must be corrected through the existing owner
ledger workflow, not recorded again as new submissions.

Recipients have no owner/contributor tools, broader ledger history or unrelated
people's records. Contributors retain their own bilateral history, queried live
for each message, but cannot directly write ledger entries. Both roles use the
same conversation for receipts, text and follow-ups. Aniket-paid purchases create
a receivable; sender-paid purchases create a payable and zero owner cash flow.
The assistant does not assign flex classification automatically.
Aniket can apply those interpretations through existing owner tools. Any later
repayment remains a separate bilateral event.

## Amounts and existing evidence

`amount_basis` distinguishes a full `bill_total` from an `owed_share` when only
the portion owed is known. Historical drafts without this field remain full bills.
A share-only report requires a description, exact purchase date, payer and positive
INR amount, but no invented receipt or itemisation. Its preview explicitly labels
the unknown full total. Approval creates a dated interpretation and receivable or
payable with zero cash flow, without fabricating a raw bank transaction. If fuller
bank evidence arrives later, the owner must reconcile the report before counting
it again. A repayment or correction of an existing expense is not a new purchase.

`inspect_split_draft` surfaces same-day candidate transactions, including larger
bills for reported portions, and prior share-only reports. Owner approval can use
`existing_raw_transaction_id` for an owner-paid debit with an ordinary, unsplit
interpretation. Linking preserves raw evidence, existing cash flow and billing
metadata, and versions the interpretation while creating the receivable atomically.
Existing splits, settlements and special interpretations need explicit owner
reconciliation instead of being silently overwritten. Other duplicate candidates
still require acknowledgement even when a debit is linked.

Approval only records the financial event and queues its decision notification.
It never automatically sends a payment request or QR code. The owner must ask for
those separately. Whole-bill allocations round the nonpayer's share once and leave
the remainder with the payer, in either direction.

## Persistence and recovery

Additive tables: `split_drafts`, `split_draft_versions`, `split_inbox`,
`split_outbox`, and `payment_chat_media`. Existing raw evidence is not rewritten.
There is no migration of old messages into new expenses and no role promotion.

The inbox deduplicates Telegram messages and serializes each contact's events.
Model calls have leases and bounded retries; expired leases can be reclaimed,
and a stale model completion cannot overwrite a newer attempt. After three
failures, the sender receives a retry notice. `/retry` retries saved messages
without losing their text or receipts. The one-minute payment worker recovers
inbox/outbox work after restarts. Delivery is governed by the existing
`PAYMENT_REQUEST_DELIVERY_ENABLED` setting.

Owner and recipient notifications have separate durable delivery rows. Rate
limits can retry; unknown transport outcomes become `uncertain`. Use
`inspect_split_draft` to inspect delivery IDs and `retry_split_delivery` only
after explicit approval of duplicate-message risk. Retrying a notification does
not repeat an expense approval or resend other completed parts. Receipt copies
are separately tracked and may arrive after their review text.

Photos, PNG/JPEG/WebP files and PDFs are accepted, each up to 10 MB. Up to four
distinct receipts can accompany a draft. Validated original bytes are retained
in the database with their authenticated sender and Telegram message reference;
they are sent to the existing configured OpenAI service for extraction and to
Aniket for review. PDF signatures are checked before model submission, but
encrypted or unreadable PDFs may still need a replacement. No OCR/model claim
alone approves a balance change. Attachments add to database/backup size.

Bill labels are derived from linked expense evidence in Asia/Kolkata. Sent dates
are never substituted for missing purchase dates. Historical relative text stays
in its original audit record but is not reused as the current bill title.

## Rollout and checks

- Build and run the mocked/local tests before merging. No live expense, receipt
  submission or message send is required to validate the code.
- Deploy the approved PR. Startup adds the tables and uses the existing delivery
  gate; it does not notify past senders or replay historical screenshots.
- Verify version 1.18.0, existing scheduler health and `split_submissions` queue
  counts. Check ordinary owner/contributor conversations still work, including
  natural shared-tab questions while a draft is pending. No schema migration is
  needed for the bilateral extension; it uses the existing draft/evidence tables.
- With separate authorization, run a recipient canary: describe a bill, upload a
  receipt separately, clarify payer, confirm preview, reject with a note, correct
  and resubmit, then approve. Verify no balance change before approval and exactly
  one afterwards. Verify receipts and both notifications arrive.
- Parikshit's failed November 10 upload was not retained by the old recipient
  handler. Ask him to resend the receipt and original allocation after rollout;
  do not invent or import an expense from the chat screenshots.

If rolling back, pause non-owner conversations and the payment delivery worker
first and inspect pending drafts. Older versions assume sender-paid full bills and restore contributor direct
writes, so do not resume friend chats on those versions. Keep their evidence
and approved financial records intact and explain the temporary pause to users.
