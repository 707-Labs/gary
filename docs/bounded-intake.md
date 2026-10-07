# Bounded ticket intake

The daemon and `scripts/probe-loop-tick.ts` require a durable spending allocation
before dispatching any assigned or mentioned ticket. Existing unallocated
tickets remain idle. For the current campaign they use only the configured
DeepSeek API provider, which is metered usage from an existing balance.
Z.ai Coding Plan eligibility for Gary's custom client and Kimi Extra Usage
pricing/account status are unverified; neither is an automatic fallback.
Credentials and subscriptions are not changed by this implementation.

An operator may create an allocation without assigning a ticket or calling a
model:

```sh
bun scripts/budget.ts /absolute/state/spend.db enroll CAMPAIGN_ID CAMPAIGN_USD LINEAR_ISSUE_UUID TICKET_USD --draft
bun scripts/budget.ts /absolute/state/spend.db status LINEAR_ISSUE_UUID
bun scripts/budget.ts /absolute/state/spend.db close LINEAR_ISSUE_UUID operator_stopped
```

Use the Linear issue UUID. Repeating an enrollment cannot raise a cap, change
draft mode, change its campaign, or reopen a concluded allocation. Campaign
allocations cannot exceed the campaign cap. Other agents' budgets must be
reserved separately before choosing that cap; the ledger does not read their
invoices or infer their spending.

Every HTTP attempt reserves the full supported input context and requested
maximum output at conservative published rates before sending. This includes
SDK retries, fallback, classification, review, and subagents. Atomic SQLite
transactions share the allocation across concurrent ledger connections.
Uncertain outcomes and process crashes retain the reservation. Recognized
receipts may release unused input allowance; full output allowance is retained
because compatibility endpoints may not prove how reasoning is counted.

The ledger records conservative charges/reservations, not provider invoices.
Missing cache counters, unexpected model names, additional usage fields, and
errors retain the full reservation. This can stop a task earlier than its
actual billed cost would require. Unreviewed routes, request fields, native
paid tools, streaming, or modalities fail closed. Pricing policies require
review when provider/model terms change.

Exhaustion survives later polls and restarts. A concluded coding action,
including a draft PR, closes its allocation, so later CI or review activity
does not silently renew spending. Final code, CI, review, and answer handlers
check allocation state before publication. This is financial admission, not a
universal cancellation system for every non-model tool or Linear write.

Manual model-probe scripts that call `loadGLMChain` directly are outside this
guard and must not be used for production dispatch or paid validation. Actual
executor readiness must be demonstrated before enrolling/assigning work; see
`docker/executor/README.md` for the pinned runtime and reviewed-cache process.
