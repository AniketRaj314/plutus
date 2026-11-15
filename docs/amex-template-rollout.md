# AmEx template support, v1.17.1

## Behavior

Plutus accepts both AmEx transaction-alert senders and both the legacy
paragraph and newer nested-table layouts. The parser accepts named-month and
DD-MM-YYYY dates. Polling and diagnostics use the same sender registry.
Declined-payment and security notices are excluded. Invalid dates, conflicting
fields and unsupported amounts remain retryable. Currency and FX behavior is
unchanged.

## Rollout

1. Before rollout, verify that known duplicate alerts have explicit evidence
   links to their canonical transactions. Do not change raw ledger records or
   infer matches from merchant, date, or amount alone.
2. The parser revision triggers the existing bounded 48-hour replay. Do not
   clear processed IDs or polling timestamps. Explicit evidence links prevent
   duplicate ingestion and notification; genuinely new alerts follow normal
   processing.
3. After rollout, verify the live version, scheduler health, and diagnostics for
   both senders. Confirm that linked alerts still resolve to one raw transaction
   each. This release does not change allocation inference.
4. Review any older gap separately if needed. The replay is not a historical
   backfill.

Regression tests use synthetic data. Keep production reconciliation records in
private, access-controlled notes, not in this repository.
