# Plutus backend context

This repository contains the backend deployed from `main`. Financial amounts,
balances, scheduler status, and deployed revisions must be checked live, never
inferred from this document or a pending pull request. Keep raw transaction
evidence immutable and separate personal impact, cash flow, flex impact, and
receivables. See [v2 ledger](v2-ledger.md) for the financial model.

## Contact and payment-request rules (approved October 30, 2026)

- One canonical contact joins retained ledger-name aliases and a verified numeric
  Telegram identity. A username is a claim-time hint, not enduring identity.
- The same private invitation flow grants recipient access by default.
  Contributor adds own bilateral history and reporting purchases paid for Aniket.
  Existing contributors retain their role. All non-owner financial chats are private.
- Send only after Aniket explicitly asks to inform the selected people. New debt,
  preparation, or joining alone does not authorize a payment request. No recurring
  reminders or automatic delayed sending after someone accepts an invite.
- Requests are communication records, never debt or settlements. A recipient's
  payment claim is evidence for owner review. Independent transfers remain
  standalone bilateral events, not arbitrary invoice allocations.
- Canonical snapshots are rechecked before dispatch. Repayment ambiguity requires
  owner resolution or explicit selection of the net-balance basis. AI writes
  warmth only; code supplies amounts and copyable UPI `9969596700@ptyes`, followed
  by "(click on the UPI ID to copy)" outside the inline-code formatting.
- Successful sends deduplicate; ambiguous outcomes require explicit review and
  retry approval. Opt-out and permission changes invalidate existing drafts.
- Delivery is disabled by default. See [payment requests](payment-requests.md)
  for rollout, owner-only canary, recovery, and the old-code rollback restriction.

Implementation on a branch is not evidence of deployment. Do not enable delivery
or send a live canary without the separately authorized rollout action.
