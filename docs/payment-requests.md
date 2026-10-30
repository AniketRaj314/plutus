# Contacts and payment requests

One contact connects existing ledger names, retained aliases, a verified Telegram
identity, and communication history. Payment requests never create debt or change
personal spending, cash flow, receivables, or the bilateral balance.

## User journey

1. Aniket identifies a contact and optionally their Telegram handle. Violet
   creates a private, expiring Start link through `create_contact_invite`.
   The default role is `recipient`. Aniket shares the link himself.
2. The person starts Violet in a private chat. Telegram's numeric sender ID
   becomes the identity. A supplied handle must match when claiming the invite;
   subsequent handle changes do not transfer access to another person.
3. A recipient can receive requests and reply to a specific sent message.
   Contributor access adds the person's own bilateral tab and reporting of
   purchases paid for Aniket. Both roles use the same contact and invite system.
   Existing contributors retain that access and gain recipient capabilities.
4. After a confirmed split, Aniket says to inform the selected people. Violet
   prepares the exact selected receivable IDs, then authorizes those drafts.
   Preparation alone sends nothing. The once-per-minute outbox handles delivery.
   Violet reports queue status accurately; `list_payment_requests` provides
   actual per-person outcomes, and `get_payment_request_replies` returns replies.
5. Unconnected people need to join first. Their old drafts become stale. Aniket
   gives a fresh send instruction after new preparation; joining never sends a
   dormant demand. No new debt or recurring reminder triggers delivery.
6. Recipients use `/stop_requests` (or `/stop`) and `/resume_requests`. Opting out
   invalidates previously prepared/queued drafts, including after resuming.
   Replying "paid" stores evidence for Aniket's review without settling anything.

Recipient replies use a deterministic, restricted handler. They do not invoke
the owner or contributor AI, and recipient attachments are not downloaded.
Reply text is available to the owner as untrusted evidence. Contributors still
have the existing AI discussion of their own shared tab; direct replies to
payment requests use the same restricted reply handler as recipients.

## Identity and access

- `contacts` and unique `contact_aliases` resolve both old names and stable IDs.
  Existing financial evidence retains its original spelling and source IDs.
- Financial person names, receivables, and existing invitation identities are
  backfilled at startup. Unknown counterparties, including organizations, are
  not automatically invited or classified as people.
- The existing `telegram_contributors` and `telegram_contributor_invites` tables
  are extended in place. No second authorization registry exists. Tokens remain
  hashed, single-use, and expiring. Reissuing invalidates prior pending invites.
- Role changes require an authenticated owner context, injected by the Telegram
  gateway or authenticated API/MCP endpoint. Model arguments cannot supply it.
  Background agent runs do not expose access or payment tools.
- `set_contact_access` promotes, demotes, or revokes a contact, including a pending
  invitation. Revocation preserves financial history and invalidates drafts.
  Restoring revoked access needs a fresh invite. A claimed token cannot restore
  old permissions, or link a second Telegram identity to the same contact.
- Contributor actions and responses recheck access after model execution.
  Contributor financial conversations are private-chat only. The owner's existing
  configured topic remains supported.
- The migration fails transactionally if multiple legacy Telegram identities
  resolve to one contact. Review that collision explicitly before rollout.
  Renaming does not merge existing contacts. Identity merging/relinking is outside
  this change and must never be guessed from a handle or similar display name.

## Financial and message checks

Selected splits must be confirmed, pending, and attached to active interpretations
where an entry exists. Any uncertain bilateral evidence blocks preparation.
Possible repayments/offsets block a split request, even if its receivable still
says pending. Aniket must explicitly choose the canonical net balance, or resolve
the underlying evidence. The system never allocates independent transfers to
old expenses. Net requests also reject inactive linked interpretations.

Snapshots include the contact version, role, private destination, delivery
permission, selected sources, complete bilateral money evidence, and configured
UPI. Authorization expires after 24 hours. The outbox rechecks the fingerprint
immediately before each send. Any relevant change requires fresh preparation.

AI writes only a short greeting and closing. Code renders the authoritative
amount in paise, owner-supplied shareable context, and inline-code UPI. Invalid
wording uses a safe fallback; model/API failure leaves that recipient unprepared.
Names and context cannot supply Telegram HTML markup. A request fits one Telegram
message, so partial multi-message sends cannot split the payment instruction.

Deduplication is independent of the owner's command/update ID. Repeating the same
request returns its existing state. Overlapping source sets in queued, sent, or
uncertain requests block another payment demand, including a later combined or
net request covering those sources. This release does not support recurring
reminders, correction notices, or manual clearing of already-sent demands.

## Outbox and recovery

`payment_requests` stores the exact message and snapshot. `payment_batches` and
`payment_batch_items` group results; requests may be reused across commands.
`payment_attempts`, `payment_audit`, and `payment_replies` preserve outcomes and
communication evidence separately from the financial ledger.

| State     | Meaning and next step                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| draft     | Prepared only; needs an explicit owner send instruction                                    |
| queued    | Authorized, awaiting worker or rate-limit delay                                            |
| sending   | Claimed with a two-minute lease                                                            |
| sent      | Telegram returned a message ID and it was persisted                                        |
| failed    | Telegram definitively rejected, or pre-send configuration failed; repair and prepare again |
| uncertain | Transport/response ambiguity or expired sending lease; no automatic retry                  |
| stale     | Snapshot/permission/expiry changed; prepare again                                          |
| cancelled | Owner cancelled an unsent request                                                          |

Telegram has no client idempotency key. A crash after acceptance but before
persisting the message ID is uncertain, never silently retried. Aniket may
explicitly approve `retry_uncertain` after understanding duplicate risk, only
while the original snapshot remains current. A changed uncertain request stays
blocked for investigation. HTTP 429 alone gets an automatic delayed retry,
capped at five attempts. HTTP 403 marks the connection unreachable. A recipient
can start/unblock Violet and use `/resume_requests`, then Aniket prepares again.

Provider references: [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage)
and [private Start links](https://core.telegram.org/bots/features#deep-linking).

The delivery flag stops future sends, not an HTTP request already in flight.
Use one Railway instance with the persistent SQLite volume. The worker's atomic
claim also prevents two workers sharing the database from sending the same row.
Outbox recovery runs with delivery disabled but never contacts Telegram.
`/health.payment_requests` exposes the gate and counts only. Errors use fixed
codes, not bot tokens, message text, or raw provider responses.

## Rollout, separately approved

This PR does not deploy, enable delivery, or send messages.

1. Back up the current persistent SQLite database using SQLite's backup mechanism
   while preserving the WAL. Test migration on that copy. Compare raw evidence,
   receivable totals, canonical balances and active contributor identities before
   and after. Resolve any identity collision explicitly.
2. Deploy with `PAYMENT_REQUEST_DELIVERY_ENABLED=false` and the existing database
   path. Do not follow the historical clean-v2 database reset procedure.
   `PAYMENT_REQUEST_UPI_ID` defaults to `9969596700@ptyes` and can be configured.
   `TELEGRAM_BOT_USERNAME` enables clickable invitation links.
3. Verify `/health`, the new MCP tools, preserved aliases/contributors, and
   zero unintended queued requests. Existing ingestion and owner notifications
   continue normally. The outbox never creates financial events.
4. After explicit permission for one live owner-only message, run
   `npx ts-node scripts/payment-delivery-canary.ts --send-to-owner` in the deployed
   environment. This script uses the configured owner ID, opens no database,
   starts no scheduler, and sends a clearly labeled test with no money request.
   Check the copyable UPI in the owner's Telegram chat. If ambiguous, inspect
   that chat before retrying.
5. Review/cancel stale test drafts and queues. Enable delivery explicitly only
   after the canary, then use a newly approved real request and verify its saved
   Telegram message ID and reply handling. Enabling may resume already queued,
   unexpired requests whose snapshots remain current, so inspect the queue first.
6. To pause, disable delivery and inspect any sending/uncertain rows. Do not
   restore an old DB snapshot or delete the outbox after live sends: losing send
   receipts can cause duplicates. Preserve the database and audit evidence.

Do not roll back to a pre-role application against this database after recipients
have joined: old code interprets every active row as a contributor. Prefer a
forward fix with delivery disabled. If rollback is unavoidable, stop service,
back up the current DB, and explicitly review removal of recipient-only access
from the legacy authorization surface before restarting old code. Never drop
financial rows or erase the sent-request history as part of rollback.

## Verification

Run `npm run build` and `npm test` on Node 22. Tests use in-memory databases,
mocked model responses, and mocked Telegram transport. Coverage includes legacy
migration, aliases, private claims, role layering/revocation, restricted replies,
no implicit settlement, stale snapshots, overlapping obligations, partial
failure, rate limiting, duplicate commands, opt-out, and crash recovery.
