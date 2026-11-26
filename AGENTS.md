# Plutus project instructions

## Required context

- Before financial analysis, transaction classification, production operations, MCP work, Telegram or Violet changes, or changes to financial behavior, read `docs/PLUTUS_CONTEXT.md` in full.
- Treat amounts and operational status in that file as historical snapshots. For current balances, transactions, receivables, flex status, deployed version, and scheduler health, query the Plutus MCP or another live production source.
- If the Plutus MCP is unavailable, say so clearly. Do not infer a current financial total from historical chat context.
- When a durable product rule, accounting invariant, recurring commitment, card cycle, or operational decision changes, update `docs/PLUTUS_CONTEXT.md` in the same change.

## Product boundary

- Plutus stores reliable financial facts and evidence, while AI agents provide financial interpretation and guidance.
- Keep raw transaction evidence immutable. Corrections should create or replace interpretations without rewriting the original bank evidence.
- Prefer general tools, provenance, confidence, and correction workflows over hardcoded merchant-specific financial reasoning.
- Preserve the working ingestion, deduplication, MCP, Telegram, authentication, and deployment infrastructure unless a task explicitly changes it.

## Financial invariants

- Separate personal impact, cash-flow impact, flex impact, and receivables. They answer different questions and must not be collapsed into one number.
- Card-bill payments and transfers between the user's own accounts are settlements, not new spending.
- Reimbursable expenses affect cash flow but should not remain in final personal spending once correctly interpreted.
- If another person pays for the user, record the economic expense when it happens. A later repayment changes cash flow and the bilateral balance without counting the expense twice.
- Keep interpersonal payments as standalone events and calculate the net balance. Do not silently allocate arbitrary payments to old expenses.
- EMI conversion bookkeeping is not the monthly expense. Prefer actual statement EMI rows, including interest and tax, and ask before deriving a tenure or forecast.
- Treat AmEx authorization or transaction alerts as transaction events immediately. Preserve issuer status as evidence, and use later reversals to offset them.

## Working practices

### Publication safety

- Treat every commit, branch, PR description, comment, doc, fixture, and CI log as public.
- Never put real ledger or email data there, including amounts, merchants, timestamps, card digits, or message IDs.
- Use fully synthetic fixtures that preserve the format and edge cases, not real records with just the names changed.
- Keep production evidence and reconciliation notes in a private, access-controlled location.
- Before pushing or opening a PR, review the full diff, every commit being pushed, and the PR text for leaks. If you find one, stop publication and fix it first.
- If it was already published, tell the user privately without repeating the data in GitHub.

### Implementation and operations

- Inspect the current repository, branch, production version, and MCP surface before relying on implementation history from the context document.
- For production backfills or financial mutations, show the proposed records or interpretation when useful and obtain explicit approval unless the user has already authorized that exact operation.
- Reconcile imports against existing raw evidence before writing, and report duplicates, exclusions, failures, and unresolved items.
- Keep Telegram and Violet responses concise by default, with tables for transaction lists and details on request.
- Never use em dashes in user-facing text, prompts, documentation, or code comments.
- Run the relevant build and tests after code changes. Do not claim deployment or production state without verifying it.
