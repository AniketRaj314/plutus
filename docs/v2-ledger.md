# Plutus v2 ledger

Plutus v2 keeps the backend deliberately mechanical: it stores bank evidence,
AI/user assertions, shared context, commitments, and receivables. Financial
judgment and weekly-budget recommendations belong to the MCP client/agent.

## Data flow

1. Gmail parsing writes an immutable row to `raw_transactions` and a matching
   compatibility row used by the proven enrichment and Telegram code.
2. Telegram alerts keep using the existing message-to-transaction id mapping.
   Raw and legacy ids are intentionally identical.
3. The automatic AI worker interprets a new row before its final Telegram
   alert. Card-cycle and salary-month routing remain deterministic backend
   facts; financial treatment comes from the model and persisted context.
4. Low-confidence or materially ambiguous rows remain in
   `list_uninterpreted_transactions` with a transaction-scoped clarification
   question. Telegram replies or MCP agents can resolve them.
5. Corrections create a new entry with `supersedes_id`; raw evidence is never
   overwritten and old interpretations remain auditable.
6. `get_funding_summary` only groups and sums stored interpretations. The agent
   uses those facts to recommend a weekly budget.

## Impact fields

- `gross_amount_inr`: INR value visible in the interpreted event.
- `personal_impact`: true expense against the salary month's ₹1,20,000 limit.
- `cashflow_impact`: temporary cash required or received.
- `receivable_amount`: amount expected back when the entry was interpreted.
- `outstanding_receivables`: live outstanding balance derived from linked
  `receivables` rows and returned by `get_funding_summary`.

Example: a ₹5,000 employer-reimbursable card charge starts with personal impact
₹0, cash-flow impact ₹5,000, and receivable ₹5,000. When money arrives, the
agent updates the receivable and records the incoming cash as another clean
entry if it should affect the funding-month cash-flow view.

## Forecast replacement

Commitments are reusable facts, not spend. An agent creates an explicit
`forecast` entry for each funding month. When the actual charge appears, the
actual entry supersedes the forecast. The active-entry uniqueness constraint
and supersession transaction prevent double-counting.

## Card routing

Card dates are configuration, not financial policy. `get_card_cycle_for_date`
maps a transaction to the configured cycle, due date, and due-date salary
month. Current boundaries are:

- AmEx: 21st–20th, due 8th.
- BOBCARD: 22nd–21st, due 9th.
- IDFC CC: 20th–19th, due 4th.

## Migration

Legacy tables remain as rollback/compatibility storage, but production MCP and
the Telegram agent expose only v2 finance tools. The legacy envelope cron and
Gmail envelope mutation are disabled. Migrations can still copy existing
legacy evidence/context when an old database is opened; a clean production
cutover should use a new SQLite path instead.

Recommended cutover:

1. Snapshot the production SQLite database.
2. Start a new SQLite file with automatic inference temporarily disabled.
3. Backfill raw evidence, review the proposed interpretation table, and write
   approved v2 entries/context/receivables through MCP.
4. Compare v2 funding summaries with reviewed acceptance fixtures.
5. Enable automatic inference and verify one live Gmail → Telegram journey.

Automatic inference is controlled by `AUTO_INFERENCE_ENABLED` and defaults to
enabled. The live Gmail path attempts inference immediately; the retry queue
runs every `AUTO_INFERENCE_INTERVAL_MINS` (default five), skips clarification
requests, and stops retrying model failures after three attempts.
