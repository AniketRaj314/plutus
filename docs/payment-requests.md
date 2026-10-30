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

## Conversational replies (1.15.0)

Recipients can ask about a sent request and then continue without using Telegram
Reply each time. A session lasts 24 hours. If several requests could apply,
Violet lists short choices and retains the original question while the recipient
chooses. A new request makes an older active selection ambiguous. `/splits`
switches requests; contributors use `/tab` to leave the bill conversation and
access their existing bilateral tools. A plain `/start` from an unlinked private
user explains that they need Aniket's personal invitation, without granting access.

The recipient assistant has no tools and never loads owner/contributor history
or a full financial snapshot. Its input contains the recipient's sent request,
their conversation, explicitly relayed owner answers, current shareable bill
explanations, and a change marker. It explains item allocations, discounts,
fees and credits only when asked. Missing evidence goes to the owner. A sent
amount is historical, not a fresh balance. Changed financial evidence invalidates
explanations and requires owner review, rather than silently editing a request.

### Owner discussion and privacy

`get_bill_conversation_context` resolves a raw transaction, interpretation,
receivable or payment request to stable bill identities. It joins the receipt
facts, interpretations, receivables and linked owner discussion. Telegram replies
to transaction notices and recipient alerts attach the owner turn automatically.
For ordinary follow-ups, the owner agent selects the exact reference with this
tool. This lets it retain relevant discussion outside its recent-chat window.
Historic owner messages are imported only with an exact transaction marker and
their immediately following assistant response. Unlinked old chats are not
guessed from merchant/person names.

The owner agent uses `save_bill_explanation` to publish a concise explanation for
each relevant contact after decisions are confirmed. It records source message
IDs and the financial revision. `tentative` and `private` explanations remain
owner-only. The recipient model receives only the confirmed explanation for its
own contact at the current revision. Raw owner conversation, receipt payloads and
the rest of the bilateral ledger do not cross that boundary. This is an AI-curated
projection, so review the explanation when resolving an ambiguous allocation.
Existing requests still work using their originally authorized context; richer
historical calculations need a linked discussion and a confirmed explanation.

### Notification and reply loop

New recipient events are persisted before model work. The classifier distinguishes
supported answers/small talk from disputes, payment claims, unresolved questions
and requests to tell Aniket something. Actionable messages enqueue an owner alert
with the person, bill and their words. The recipient is told "notified" only after
Telegram accepts that alert. Queued, failed and uncertain outcomes are described
honestly. AI failures also escalate the saved question, rather than losing it.

Aniket replies to the alert to discuss the bill privately, or says "Tell them:
..." to authorize a relay through `reply_to_split_recipient`. The agent reports
the actual delivery status. `list_split_conversations` exposes recipient messages,
pending reviews and deliveries. `resolve_split_conversation` marks a concern
reviewed; it never records a repayment or changes a balance. `manage_split_message`
cancels queued messages or retries failed/uncertain sends after explicit approval.
An uncertain retry can duplicate a message, so it is never automatic.

The same one-minute worker handles the durable conversational inbox and outbox.
HTTP retries, duplicate updates and concurrent ticks do not duplicate committed
responses. Interrupted sends become uncertain. Only known Telegram rate limits
retry automatically, at most five attempts. Identity, role and opt-out changes
are checked during model work and before recipient delivery. In-flight network
requests cannot be recalled. After an opt-out, already queued recipient messages
remain cancelled even if the recipient resumes. Owner alerts retain the original
review evidence. Old `payment_replies` can be read as conversation history but
are not replayed as alerts by migration.

`/health.payment_requests` adds conversation event/delivery counts and the number
awaiting owner review, without message content. Use the owner tools to inspect
failed or uncertain deliveries. Retry failed processing by investigating its
fixed status and restoring the relevant dependency; do not delete event/outbox
rows to force a resend. Keep the database when rolling back. Version 1.14.1 will
ignore the new queues and lose the improved interaction until a forward deploy.

### Release verification

Tests use fresh in-memory databases and mocked model/Telegram calls, including
privacy projections, unthreaded conversation, multi-bill selection, owner reply
routing, truthful notification failures, payment-claim isolation, permission
changes during model work, concurrent processing, migration and recovery.
No real recipient messages are sent by the tests or by schema migration.
Deployment remains a separate action. Once deployed, validate a consenting test
recipient's question, dispute and owner relay; inspect health and delivery IDs.
