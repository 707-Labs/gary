# Slack shared-channel conversation

`src/slack/shared-conversation.ts` holds Gary's isolated context for workspace channel threads.
`src/slack/service.ts` routes Slack events into it. Neither has DM or coding authority.

## Which messages Gary answers

- **An explicit mention opens a thread.** An `app_mention` event whose text contains `<@U0C7NPEUG1F>`
  creates the thread session (keyed by app, team, channel and `thread_ts`) if none exists, then answers.
  A mention in an older thread starts with empty local context; Gary never fetches Slack history.
- **Plain replies continue an open thread.** A `message` event with a `thread_ts`, no `subtype`, no
  `bot_id` and a human `user` is routed as `thread_reply` when, and only when, that thread already has an
  active session. Replies elsewhere are dropped before any identity refresh, outbox read or Slack
  metadata lookup, so members talking among themselves in other threads cost nothing.
- **A reply never opens a thread**, never carries a mention (those arrive separately as `app_mention`
  and are routed only there) and is never a thread root (`thread_ts` must differ from `ts`).
- `SHARED_CONVERSATION_POLICY.trigger` is `explicit_mention`: it names what opens a thread, not what
  continues one. The value is part of the context-store fingerprint and cannot be renamed in place.

## Cost of dynamic replies

Every plain reply from any full member in a joined thread is a paid model call and a Gary post, and it
counts against the same lifetime budgets a mention does: 64 accepted events and 16 sessions per context
directory, 12 turns per thread. Two people discussing Gary's answer inside his thread spend those turns
on each other's messages. This is the accepted trade-off for conversational follow-ups (2026-10-10). If
the budget drains too fast, the narrower options are answering only the member who opened the thread,
or requiring a reply to Gary's own message; both are service-level changes and need no new context
directory.

Before this routing existed Gary answered only `app_mention` events, so a follow-up such as
"what are you working on now?" posted in his own thread was logged as `service_event_not_mention`
and silently dropped (2026-10-09, #all-707-labs).

## Checks shared by both kinds

Every turn re-reads member and channel metadata (`authorize`): the sender must be an active, internal,
full member of T0AA24R7VUZ and the channel a non-shared, non-archived workspace channel Gary is a
member of. Event and message keys are durable, so a redelivered or replayed message is never answered
twice. Turn, session, queue, input and context byte limits come from `SHARED_CONVERSATION_POLICY`,
which is part of the context-store fingerprint and must not change without a new context directory.

## When Gary stays quiet

- A paused thread (a failed or ambiguous delivery blocks its session) or an exhausted thread (12 turns)
  drops plain replies silently. An explicit mention there still receives one bounded notice.
- Admission limits (queue full, store blocked, allocation exhausted, oversized input) send the bounded
  "within the current conversation limits" notice only for mentions. Replies are dropped with the
  `shared_admission_rejected` diagnostic and no message.
- A failure after a reply has started still posts the "This thread is paused" notice, because Gary
  was already answering.
- A follow-up posted while the opening mention is still being authorized is dropped: the session row
  exists only after that mention's metadata round-trip, and the reply is not retried.
- A reply sent with "also send to #channel" arrives with the `thread_broadcast` subtype and is dropped
  like every other subtype. Messages from Slackbot are rejected at the service gate.

## Diagnostics

Ingress stages are an allowlist in `src/slack/ingress-diagnostics.ts`; they carry booleans and kinds,
never message bodies or IDs. Thread routing adds `shared_thread_ignored` (unthreaded channel message),
`shared_thread_shape_rejected`, `shared_thread_mention_deferred`, `shared_thread_inactive` (no active
session, paused or exhausted thread, blocked store or spent allocation) and `shared_thread_dispatch`
(handed to the shared layer, which may still reject the input). Every channel message now emits one of
these in addition to the generic service stages, and the emitter stops after 256 diagnostics per process
(`diagnostics_limited`), so a quiet log after a long uptime means the budget is spent, not that no
events arrived.
