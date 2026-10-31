# AmEx currency parser rollout

Version 1.16.1 adds AmEx currency aliases and validates ISO codes against the
Node 22 ICU catalogue (162 codes on the development runtime). It adds no
dependencies or schema migrations. It does not change other issuers' parsers.
Examples: USD/US$/$, SGD/S$/SG$, INR/Rs./Rs/rupee symbol, MYR/RM,
THB/baht symbol, PHP/peso symbol, EUR/euro, GBP/pound, AUD/A$/AU$,
CAD/C$/CA$, HKD/HK$, NZD/NZ$, TWD/NT$, JPY/JP¥/¥ and CNY/CN¥.
All recognised ISO codes accept prefix or suffix placement.

## Reconcile before merge or deployment

The October 31 read-only audit found a queued October 5 AmEx GRAB RIDES-EC
alert for MYR 12.36 already represented by a statement import settled at INR
303.91. These are historical findings, not current production assertions.
Merchant descriptions and timestamps differ, so existing content deduplication
will not protect this pair. Do not merge into auto-deploying main until this
pre-deployment reconciliation is complete.

1. Recheck the exact queued Gmail message and statement raw transaction against
   live production. Confirm account, direction, original currency/amount, issuer
   date, merchant and statement evidence. Resolve any mismatch before writing.
2. With approval for this exact reconciliation, use the existing
   `recordTransactionEvidence` helper to insert a `gmail` evidence link from the
   exact message ID to the canonical statement raw ID. Preserve source metadata,
   received time and the reviewed reconciliation rationale in its payload.
   Check any existing `(channel, external_id)` link first; a different target is
   a conflict, not permission to overwrite or ignore it. Verify the resulting
   link, including its raw target, before continuing.
3. Do not modify either original evidence record, settled INR, interpretations,
   balances, processed IDs or retry IDs. The old parser still rejects RM, so the
   queue should remain pending until the new deployment handles it.
4. Merge/deploy after the evidence link is verified. Do not bump the parser
   replay revision: queued IDs are retried regardless of age, and a broad replay
   is unnecessary. Polling and other normal background work resume on startup.
5. After the next normal poll, verify version 1.16.1, Gmail connection and clean
   poll health, removal of this ID from the retry queue, and diagnostic status
   `ingested` pointing to the existing statement transaction. Verify there is
   still one economic charge and its original MYR and settled INR are unchanged.
   The linked email must not create a transaction notification, interpretation
   or expense. The existing backlog-recovery notification may be sent once.

No production writes, live ingestion or live messaging are part of local tests.
Other newly supported foreign alerts without evidence links follow normal
ingestion, with INR unresolved and normal notifications.

## Recovery

If deployment fails, leave the evidence link intact and roll back code. The old
parser will keep this RM email pending, without adding another charge. Do not
clear retry state to hide the warning. If reconciliation cannot be verified,
stop before deployment. If an unexpected duplicate is discovered, pause the
rollout and reconcile through the normal audited correction workflow; do not
delete or rewrite original transaction evidence.
