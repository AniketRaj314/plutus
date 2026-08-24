# Production cutover

This is a clean v2 cutover, not an A/B rollout. Keep the old SQLite file for
rollback, but start production on a new database path.

## 1. Prepare and preserve rollback

1. Keep `/data/plutus.db` unchanged and take an external copy if convenient.
2. Deploy the v2 build with `DATABASE_PATH=/data/plutus-v2.sqlite`.
3. Initially set `AUTO_INFERENCE_ENABLED=false` so the historical backfill can
   be reviewed before clean interpretations are written.
4. Keep the existing Gmail, Telegram, API bearer-token, webhook, and OpenAI
   environment variables unchanged.

Suggested inference settings:

```text
AUTO_INFERENCE_ENABLED=false
AUTO_INFERENCE_INTERVAL_MINS=5
AUTO_INFERENCE_MIN_CONFIDENCE=0.75
INFERENCE_MODEL=gpt-4o
```

Violet's owner and contributor conversations default to the flagship model at
high reasoning. These overrides are optional:

```text
VIOLET_MODEL=gpt-5.6-sol
VIOLET_REASONING_EFFORT=high
```

## 2. Deployment smoke test

1. Confirm `/health` reports `status=ok`, the expected package version,
   `next_cron_at`, scheduler-specific `next_run_at` values, and the intended
   `violet_ai` model configuration. The new database path appears in startup
   logs.
2. Confirm MCP lists `create_raw_transaction`,
   `bulk_create_raw_transactions`, `list_uninterpreted_transactions`,
   `infer_raw_transaction`, `interpret_pending_transactions`,
   `create_envelope_entry`, `get_spend_month_summary`, and
   `get_funding_summary`.
3. Confirm legacy envelope mutators such as `recalculate_envelope` are absent.
4. Confirm `get_salary_profile` returns salary day 1 and monthly limit
   ₹1,20,000.

## 3. One-time backfill

1. Import the reviewed CSV rows with `bulk_create_raw_transactions`. Do not
   recreate them through legacy transaction tools.
2. Verify raw count/date/source/amount totals and inspect
   `list_uninterpreted_transactions`.
3. Recreate the known shared facts and commitments through
   `set_context_fact` and `create_commitment`.
4. Have an MCP-connected agent produce the proposed interpretation table
   without writing it.
5. After review, persist entries, receivables, and corrections through the v2
   tools. The unique active-entry constraint makes a raw transaction impossible
   to count twice.
6. Verify the known AmEx acceptance fixture:
   - personal impact: ₹40,050.89
   - cash-flow impact: ₹50,643.69
   - receivable amount: ₹10,592.80
   - personal envelope remaining: ₹79,949.11

## 4. Enable the live journey

1. Set `AUTO_INFERENCE_ENABLED=true` and restart/redeploy the service.
2. The Gmail poller runs every `POLL_INTERVAL_MINS` (default ten). Each new
   normal transaction is stored, interpreted, and sent to Telegram in that
   poll. IDFC UPI debits wait for the five-minute receipt-enrichment worker
   before inference; card alerts are interpreted and notified immediately.
   For every live debit, the worker uses AI to inspect candidate receipt emails
   received within one hour before or after the transaction alert. A confident
   amount/time match enriches the same transaction and edits its Telegram
   message; it never creates a second expense.
3. The inference queue retries transient model failures every five minutes up
   to three times. Ambiguous rows stay pending with a Telegram question.
4. Make one small real transaction and verify raw evidence, one active clean
   entry, the correct funding month, summary movement, and Telegram threading.
5. Reply to the Telegram alert with a correction/context and verify the clean
   entry is superseded rather than duplicated.

### IDFC savings-account SMS ingestion

Set `SMS_INGEST_TOKEN` to a new strong random value in Railway. The iPhone
Shortcut sends matching transaction messages to `POST /webhook/idfc-sms` with
that value in the `x-plutus-sms-token` header. `/health` then reports the
sanitized SMS queue status and the retry worker runs every five minutes.

Create two Message automations on the iPhone. One matches the exact phrase
`debited by Rs.` and the other matches `is credited with INR`. Each automation
sends only the matched message text and the current date to the webhook. Do not
use a sender-only rule: IDFC's sender prefixes rotate and the credit sender also
carries statements, standing-instruction notices, and security messages.

The service independently accepts only the observed full debit/credit formats.
Anything else—including OTP, PIN, CVV, standing-instruction and statement
messages—is rejected before raw financial storage. Rejections retain only a
one-way message hash and a copyable `SMS-...` diagnostic reference. Accepted
SMS and future Gmail evidence deduplicate into one transaction.

### Telegram owner and contributor access

Violet authorizes people by Telegram's immutable numeric user ID, not by name,
username, chat title, or message text. Configure these Railway variables before
deploying:

```text
TELEGRAM_OWNER_USER_ID=<Aniket's numeric Telegram user ID>
TELEGRAM_WEBHOOK_SECRET=<existing strong random secret>
TELEGRAM_BOT_USERNAME=<Violet's username without @; optional, for invite links>
```

Keep BotFather privacy mode enabled. In a group, the contributor should mention
Violet or reply to Violet; direct messages work normally. The access model is:

- The owner can use the full financial agent only in a direct chat or the
  configured private Plutus group/topic.
- The owner can dynamically invite, list, and revoke contributors through
  Violet. Invites are random, one-use, and expire after 24 hours by default;
  adding another person never requires a deploy.
- A contributor can record a payment they personally made on the owner's
  behalf and view only their own bilateral tab with the owner: expenses either
  person covered, direct transfers between them, and their net balance.
- Contributors cannot query unrelated transactions, accounts, cards, income,
  budgets, reimbursements, other people, or owner access controls. Their
  identity is injected by the server, so they cannot substitute another name.
- Unknown senders and unverified webhook requests are ignored before an AI or
  financial query runs.
- Each accepted contributor purchase creates one manual raw record, one owner
  expense at the reported share with zero owner cashflow, and one payable to the
  contributor. The owner receives a separate audit alert.

After deployment, `/health` must report the Telegram access-control booleans as
true and the expected `active_contributor_count`. It intentionally reports
configuration state and a count only, never anyone's Telegram ID.

## 5. Rollback

If the live journey fails, switch `DATABASE_PATH` back to `/data/plutus.db` and
roll back the application deployment. Do not delete `plutus-v2.sqlite`; it is
useful for diagnosing and replaying the failed cutover.
