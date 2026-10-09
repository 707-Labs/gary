# Scoped Slack alert intake

This optional host route accepts the reviewed Mulligan Labs Alerts producer
(`B0AJNH6K4LF`, app `A0AK0JCN5PF`) in 707 Labs (`T0AA24R7VUZ`), public internal
`#alerts` (`C0AKGTZM8KB`). It uses no model, coding dispatcher, conversation
history, project reader or spend allocation. Existing Tanner DM and explicitly
mentioned human shared conversations retain their separate handlers.

Enable only in a reviewed combined runtime using `GARY_SLACK_ALERT_CONFIG` and
`GARY_SLACK_ALERT_CONFIG_SHA256`, with the exact release in
`GARY_CONVERSATION_RUNTIME_RELEASE`. The private configuration is:

```json
{"version":1,"mode":"draft","teamId":"T0AA24R7VUZ","channelId":"C0AKGTZM8KB","botId":"B0AJNH6K4LF","appId":"A0AK0JCN5PF"}
```

The config parent is canonical, owned and mode 0700; config and the separate
`alerts.sqlite` are regular, single-link, mode 0600 files. Use a separate
directory from DM/shared/project contexts. Unexpected database recovery sidecars
stop initialization for operator review. The alert ledger never replaces or
modifies Gary's canonical action, conversation or spending records.

Initial activation uses **draft** mode. No Slack advisory is sent. Only exact
`🚨 Error Alert` attachments with `Event=runtime_failure`, `Worker=frontend`, and
`Error=Workers runtime outcome: exceededCpu` or `exceededMemory` yield a local
draft. Every attachment is checked independently. Warning rollups, heartbeats,
pending health checks and other failures are suppressed. Drafts contain fixed
enum evidence, unconfirmed impact/cause and a next diagnostic check; untrusted
free text is never copied into them. A `validated` counter records successful
full producer/channel validation for accepted or suppressed messages without
retaining unrelated content.

The shared transport preserves its existing **256 KiB pre-JSON frame limit**.
It supplies the measured UTF-8 wire length outside message JSON; alerts above
64 KiB or without that receipt are rejected before alert processing. This is
not a 64 KiB pre-JSON limit on the shared socket. Alert content is separately
limited to 32 KiB, 10 attachments, 24 fields per attachment, 64-byte field names,
4096-byte values, 128-byte titles and 8192-byte free-text strings.

Identity, shape, timestamps and bounds are checked before metadata lookup.
The only runtime read is `conversations.info` for the exact channel. Fresh
metadata must confirm current public/internal membership; external sharing or
missing facts fail closed. Raw message contract currently requires root
`bot_message`, producer `app_id`, `event_ts`, event time and explicit nonexternal
wrapper status. Verify these against a real producer event before claiming live
acceptance. Independently observed bot/app metadata alone is insufficient.

One durable owner runs at a time, with five accepted messages per rolling hour,
a 60-second deadline, at most 15-minute-old timestamps and 60 seconds of future
clock tolerance. Counts and event/message identities survive restarts. Duplicate
event IDs and alternate IDs for the same message never create another draft.
Completed keys expire after seven days; freshness independently rejects old
replays. Unknown work or delivery stays latched and never expires automatically.

The tested publisher supports one original-thread advisory only under an
independently pinned `publish` configuration. Its durable UNKNOWN claim precedes
the send and ambiguous outcomes stop further work. Switching an existing ledger
from draft to publish is rejected; do not reset its binding or replay old drafts.
Publication requires a separate reviewed transition and is not part of initial
draft activation.

For acceptance, use offline fixtures for positive/negative/restart paths, then a
real Slack event from the verified producer. A natural warning proves delivery
and suppression only. Positive live triage requires a natural eligible alert or
one clearly labeled synthetic message sent by the producer owner through an
existing authorized mechanism. Do not retrieve/export webhook secrets, post as
the producer, force a production error, open a competing socket, or describe a
local replay as a live test. No inference or remediation is authorized here.
