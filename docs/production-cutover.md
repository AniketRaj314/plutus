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

## 2. Deployment smoke test

1. Confirm `/health` reports `status=ok`, the expected package version,
   `next_cron_at`, and scheduler-specific `next_run_at` values. The new database
   path appears in startup logs.
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
   poll. UPI rows wait for the five-minute receipt correlator before inference.
3. The inference queue retries transient model failures every five minutes up
   to three times. Ambiguous rows stay pending with a Telegram question.
4. Make one small real transaction and verify raw evidence, one active clean
   entry, the correct funding month, summary movement, and Telegram threading.
5. Reply to the Telegram alert with a correction/context and verify the clean
   entry is superseded rather than duplicated.

## 5. Rollback

If the live journey fails, switch `DATABASE_PATH` back to `/data/plutus.db` and
roll back the application deployment. Do not delete `plutus-v2.sqlite`; it is
useful for diagnosing and replaying the failed cutover.
