# GARY — Build Spec

**Audience:** Claude Code, picking this up to build Gary from scratch.
**Owner:** Tanner (707 Labs / Mulligan Labs)
**Status:** Weekend 1 scope. Explicit non-goals listed in §16.

---

## 1. Overview

Gary is a Linear user at 707 Labs. Humans (and eventually other services) assign tickets to Gary, and Gary takes action: classifying the ticket, writing code and opening PRs, answering questions, or bouncing tickets he can't handle. Gary also babysits his own open PRs — responding to CI failures and review comments until a human merges them.

Gary's core abstraction is **"respond to the state of tickets assigned to me."** Linear is the queue. Gary polls Linear, derives state, picks the highest-priority action, executes one unit of work, and loops.

Gary is backed by GLM-5.1 via Z.ai's Anthropic-compatible endpoint. He runs on a Mac mini today, designed to be portable to a Linux VPS with no code changes.

Gary's voice and personality are defined in `voice.md`, which is loaded into every system prompt. **Read `voice.md` before building any handler.**

---

## 2. Scope and non-goals

### Weekend 1 goals

Deliverable: **Gary processes at least one real Mulligan Labs ticket end-to-end, including responding to at least one CI failure.**

The demo flow in §15 is the contract. If that demo runs cleanly, Weekend 1 is done.

### Non-goals (explicitly deferred)

- **Docker/VM sandboxing.** The `Executor` interface exists in Weekend 1 (so tools are written against it), but only `LocalExecutor` is implemented. Gary runs in a git worktree on the Mac mini with normal shell access. `DockerExecutor` is Weekend 2.
- **User report triage.** Gary only handles tickets assigned to him. No inbox scanning, no customer feedback classification.
- **Multi-repo support.** Weekend 1 is Ertai (the Mulligan Labs deckbuilder repo) only.
- **VPS deployment.** Design for portability but ship on the Mac mini.
- **Review comment response.** Weekend 1 handles CI failures. Responding to human review comments is Weekend 2.
- **Sophisticated scope estimation.** Gary tries, and bails (escalates) if he fails repeatedly. No upfront "this ticket is too big" detection.
- **Rebasing against moved main.** If Gary's PR branch diverges from main, he opens it anyway and lets the human handle conflicts.
- **Concurrency.** One job at a time, strictly sequential.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Gary (single Node process on Mac mini, portable to VPS)     │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Poll Loop (every 60s)                                  │  │
│  │  1. Fetch tickets assigned to Gary from Linear          │  │
│  │  2. For each, derive current state (Linear + GitHub)    │  │
│  │  3. Pick single highest-priority action across all      │  │
│  │  4. Dispatch to handler                                 │  │
│  │  5. Log transition to SQLite                            │  │
│  │  6. Sleep until next tick                               │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                   │
│                           ▼                                   │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ Classifier  │   │ CODE handler │   │ ANSWER / BOUNCE  │  │
│  │ (GLM call)  │   │ (agent loop) │   │ handlers         │  │
│  └─────────────┘   └──────────────┘   └──────────────────┘  │
│                           │                                   │
│                           ▼                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Adapters: Linear API, GitHub API, GLM (Z.ai)           │  │
│  └────────────────────────────────────────────────────────┘  │
│                           │                                   │
│                           ▼                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  SQLite (volume-mounted): transition log, loop          │  │
│  │  counters, last-action cache                            │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Key property: **The source of truth is Linear + GitHub, not Gary's local state.** SQLite is an operational record, not a queue. If Gary's SQLite is wiped, the system recovers on the next poll — he may re-do some work (e.g., re-comment on a PR), but he won't lose data.

---

## 4. Identity model

### Gary in Linear

- Gary is a real Linear user in the 707 Labs workspace
- Display name: "Gary"
- Handle: `@gary`
- Avatar: TBD (Tanner to provide; placeholder for now)
- Bio: something like "hi, i'm gary. software engineer at 707 labs. ai agent — i know. assign me tickets and i'll pick them up. i bounce things i can't do."
- API access via a Linear API key stored in env

### Gary on GitHub

**Recommended approach: GitHub App.**

- Register a GitHub App called "Gary" under the 707 Labs org
- Grant per-repo installation (just Ertai for Weekend 1)
- Permissions needed:
  - Repository contents: read/write
  - Pull requests: read/write
  - Issues: read/write (for comments)
  - Checks / Actions: read (to see CI status)
  - Metadata: read
- Gary authenticates as the App; commits and PRs are authored by `gary[bot]`
- No seat cost on any GitHub plan

**Alternative: separate GitHub user account.** If Tanner specifically wants the UX of a user profile (avatar on GitHub, "Gary" shown as a user rather than a bot), register a user called e.g. `gary-707labs`, add as outside collaborator to Ertai. Cost: free on GitHub Free org, $4/month seat on Team plan. All other spec provisions apply.

Gary's GitHub identity is abstracted behind a `GitHubClient` adapter. Swapping App → user later is a config change.

### Why GitHub App is the default

- Gary is openly an agent; `gary[bot]` is honest and on-brand
- No seat cost regardless of org plan
- Cleaner auth (installation tokens, scoped per repo)
- Less 2FA / key management overhead than a real user account

---

## 5. Personality and voice

See `voice.md`. That file is loaded into the system prompt of every LLM call Gary makes — classifier, coder, commenter. The runner should read `voice.md` from disk at startup and cache it. Changes to `voice.md` take effect on process restart.

Every system prompt is structured as:

```
[voice.md contents]

[task-specific instructions for this handler]

[current ticket / PR / context]
```

Don't paraphrase voice.md into individual prompts. Load it verbatim.

---

## 6. Poll loop and action priority

Every 60 seconds (configurable via `POLL_INTERVAL_MS`):

1. Fetch all Linear issues currently assigned to Gary (`assignee = gary`) that are not in a terminal state (done, cancelled).
2. For each issue, derive its current state by combining:
   - Linear issue state (new / classified / in-progress / awaiting-review / etc.)
   - Linked GitHub PR status (if any): open, closed, merged, draft
   - CI status on the PR head commit (passing / failing / pending / none)
   - Last-action cache from SQLite (has Gary already acted on this specific PR state?)
3. Compute the highest-priority action across all issues (see priority table below).
4. If an action exists, dispatch to the appropriate handler. Handlers run to completion (with timeouts), then return control to the loop.
5. If no action exists, sleep until next tick.

### Action priority

Highest priority first. Gary does one action per tick, then re-polls (gives new events time to surface).

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Gary has an open PR with CI failing, and Gary hasn't already attempted to fix this specific failure | `fix_ci_failure` |
| 2 | Gary has an open PR with unaddressed human review comments (Weekend 2) | `respond_to_review` |
| 3 | Ticket is newly assigned to Gary and has no classification yet | `classify` |
| 4 | Ticket is classified as `CODE` and has no PR yet | `start_coding` |
| 5 | Ticket is classified as `ANSWER` and Gary hasn't responded yet | `write_answer` |
| 6 | Ticket is classified as `BOUNCE` and Gary hasn't reassigned yet | `bounce` |
| 7 | Gary has a PR that's been idle and CI green for > `STALE_PR_HOURS` | `nudge_reviewer` (Weekend 2+) |

### Idempotence

Every action must be idempotent against the SQLite last-action cache. Before acting, Gary checks: "have I already acted on this exact state?" If yes, skip. This prevents double-commenting, duplicate PR fixes, etc.

The cache key is `(issue_id, state_fingerprint, action_type)` where `state_fingerprint` is a hash of the derived state. If state changes (new commit, new review, new CI run), the fingerprint changes, and Gary is free to act again.

### Circuit breaker

If Gary has attempted `MAX_ATTEMPTS_PER_TICKET` actions (default: 5) on the same ticket within `CIRCUIT_BREAKER_WINDOW_HOURS` (default: 6) without advancing state, Gary escalates: comments on the ticket explaining he's stuck, reassigns to the original assigner, and stops acting on that ticket.

---

## 7. Handlers

### 7.1 Classifier

**Trigger:** Ticket assigned to Gary, no classification yet.

**Action:** Single GLM call, no tool use. Outputs JSON:

```typescript
{
  classification: "CODE" | "ANSWER" | "BOUNCE",
  confidence: number, // 0-1
  scope: "S" | "M" | "L",
  reasoning: string // 1-2 sentences, used in the Linear comment
}
```

**Prompt structure:**
- voice.md
- Classifier instructions (what the three classifications mean, examples)
- The ticket title + description + any comments

**Post-action:**
- Store classification in SQLite (tied to ticket id)
- Comment on the Linear ticket announcing classification (see voice.md examples 2-4)

**Classifications:**
- `CODE`: writing code and opening a PR is the appropriate response. Bug fixes, features, refactors, test additions.
- `ANSWER`: the ticket is a question or clarification request. Gary can answer without touching code. "Why does X behave this way?" "Where is the config for Y?"
- `BOUNCE`: Gary shouldn't or can't handle this. Design decisions, tickets involving production data, tickets requiring context Gary doesn't have, tickets that are too ambiguous.

### 7.2 CODE handler

**Trigger:** Ticket classified as CODE, no PR yet.

**Flow:**

1. **Create worktree**
   - Clone Ertai fresh (or fast-forward an existing bare clone) into `~/.gary/workspaces/<ticket-id>/`
   - Use `git worktree add` from a bare clone at `~/.gary/repos/ertai.git` to avoid re-downloading history each time
   - Create branch `gary/<ticket-id>-<slug>` off `main`
2. **Run agent loop** (see §10)
3. **Post-loop:**
   - If there are uncommitted changes: commit them with a message following voice.md example 7
   - If there are commits on the branch: push, open PR
   - If no changes: comment on ticket ("i looked at this but didn't end up changing anything — here's what i found") and escalate for human review
4. **PR creation:**
   - Title: from the ticket, not "closes mul-123"
   - Body: follow voice.md examples 5 and 6
   - Always references the Linear ticket ID
   - Always includes the "i'm gary, double-check me" reminder
   - Always marked as ready-for-review, not draft (unless Gary's uncertain — then draft)
5. **Comment on Linear ticket** with PR link

### 7.3 ANSWER handler

**Trigger:** Ticket classified as ANSWER, no response yet.

**Flow:**

1. Run a constrained GLM call with access to a **read-only** version of the repo: can read files, grep, look at git log, but cannot write or run anything
2. Produce a response that follows voice.md example 3
3. Post as a comment on the Linear ticket
4. Do not change the ticket status — wait for the human to confirm the answer resolved it or ask follow-up

### 7.4 BOUNCE handler

**Trigger:** Ticket classified as BOUNCE.

**Flow:**

1. Comment on the ticket with a bounce message (voice.md example 4)
2. Reassign the ticket to whoever assigned it to Gary (fall back to ticket creator if assigner isn't clear)
3. Remove Gary from assignees

### 7.5 CI failure handler (sub-handler of CODE)

**Trigger:** Gary has an open PR, CI is failing, Gary hasn't attempted this specific failure.

**Flow:**

1. Fetch CI logs for the failing check(s) from GitHub
2. Run a scoped agent loop in the existing worktree:
   - Context: the PR diff, the CI failure output, voice.md
   - Tool access: read, write, edit, grep, limited bash (no long-running processes)
   - Instruction: fix the failure, commit, push
3. If the fix succeeds (CI goes green on next run), do nothing further
4. If CI fails again on the same check in the same way, increment the attempt counter
5. After `MAX_CI_ATTEMPTS` (default: 3) failed attempts on the same PR, escalate

---

## 8. Linear integration

### API

Use the Linear GraphQL API via `@linear/sdk`. Authenticate with a personal API key stored in `LINEAR_API_KEY`.

### Polling

- Fetch issues where `assignee.id = $GARY_USER_ID` and `state.type in [unstarted, started]`
- Include: id, identifier, title, description, state, assignee, creator, createdAt, updatedAt, comments (last 20)
- Also fetch attachments / links for finding linked GitHub PRs

### State derivation

Gary reads, but does not rely on, Linear ticket state. He derives what he should do from:
1. The ticket's classification (from SQLite)
2. The presence and status of any linked GitHub PR
3. The last-action cache

He does, however, **write** to Linear state at clear points:
- On pickup: move ticket to "In Progress" (or equivalent — make this configurable)
- On PR open: add PR link as an attachment, keep in progress
- On bounce: reassign, remove self, leave state unchanged

### Comment templates

All Linear comments should be generated from voice.md patterns. Do not hard-code comment strings in the runner. Instead, include a few-shot pattern from voice.md in each relevant prompt and let the model generate the comment in-context.

Exception: comments that are pure plumbing (e.g., "PR opened: <url>") can be templated, but prefer voice-generated.

---

## 9. GitHub integration

### Auth

Default: GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`).

Fallback: Personal access token from a user account (`GITHUB_PAT`), used if `GITHUB_APP_ID` is unset.

Abstract both behind `GitHubClient` interface with methods: `cloneRepo`, `openPR`, `getPR`, `getCIStatus`, `comment`, `getReviewComments`.

### Repo management

- Bare clone cached at `~/.gary/repos/<repo-name>.git`
- On each ticket, `git worktree add ~/.gary/workspaces/<ticket-id> -b gary/<ticket-id>-<slug>`
- After PR is open, worktree stays in place until ticket terminates
- On ticket terminate: `git worktree remove`, leave the bare clone alone
- Garbage collection: any worktree older than 7 days with no associated open ticket gets cleaned up at startup

### PR opening

- Use the GitHub API (not `gh` CLI) for consistency across GitHub App and PAT auth
- Push the branch first, then open the PR
- Set PR body to voice-generated description
- Link back to the Linear ticket in the PR body

### CI status

- Poll the `/repos/:owner/:repo/commits/:sha/check-runs` endpoint
- Treat the aggregate status as: all passing → green, any in_progress → pending, any failed → red
- Cache CI status on the last-action state fingerprint to avoid re-reacting

### Webhook support (optional, Weekend 1)

If time permits: a minimal webhook receiver for GitHub `check_run` and `pull_request_review` events, which just bumps a "please poll soon" flag. This makes Gary feel more responsive without changing the core loop. Skip if time is tight.

---

## 10. Agent loop

### Model config

- Endpoint: `https://api.z.ai/api/anthropic`
- Model: `glm-4.6` (or whatever the current GLM coding model is — read from env)
- Auth: `Z_AI_API_KEY` passed as `ANTHROPIC_API_KEY` header
- Use the Anthropic SDK (`@anthropic-ai/sdk`) pointed at Z.ai's base URL
- `max_tokens`: 8192 per turn
- Temperature: 0.3 for coding, 0.1 for classifier

### Tool list (CODE handler)

All tool implementations go through the `Executor` abstraction (see next subsection). Tools are thin wrappers over the Executor; they don't touch the filesystem directly.

- `read_file(path)`
- `write_file(path, content)`
- `edit_file(path, old_string, new_string)` — string-replace semantics, must be unique match
- `grep(pattern, path_glob?)`
- `list_files(path_glob)`
- `run_bash(command, timeout_seconds?)` — shell access within the Executor's scope
- `commit(message)` — git add -A && git commit (goes through Executor so it works in Docker later)
- `finish(summary)` — model signals it's done; loop exits

### Executor abstraction

Gary's tool implementations never call `fs` or `child_process` directly. Instead, they go through an `Executor` interface that represents "a place where code runs." This exists so the CODE handler can run tools against a local worktree in Weekend 1 and inside a Docker container in Weekend 2 **with no change to the tools, the agent loop, or the handler.**

```typescript
interface Executor {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  listFiles(pattern: string): Promise<string[]>
  grep(pattern: string, pathGlob?: string): Promise<GrepMatch[]>
  exec(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult>
  // The workspace root is set at construction time; all paths are resolved
  // relative to it, and operations outside it throw.
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}
```

**Weekend 1 ships `LocalExecutor`** — uses Node/Bun's `fs` and `child_process`, scoped to a workspace root (typically `~/.gary/workspaces/<ticket-id>/`). Path traversal outside the root throws. This is the only Executor implemented Weekend 1.

**Weekend 2 adds `DockerExecutor`** — spins up a container with the worktree bind-mounted (or copied in), runs `exec` via `docker exec`, reads/writes files via `docker cp` or the bind mount. Same interface, different implementation.

**Future: `ModalExecutor`, `SSHExecutor`** — if Gary eventually runs serverless or on a remote VPS. Same pattern.

Tools are constructed with an Executor reference:

```typescript
const executor = new LocalExecutor(worktreePath)
const tools = makeToolset(executor)
await runAgentLoop({ tools, systemPrompt, task })
```

The handler picks the Executor. The loop and tools don't know or care which one they got.

**Design note:** This pattern is lifted from the `Terminal` abstraction in Nous Research's Hermes Agent. The scope is narrower here (Gary doesn't need SSH or Singularity backends) but the principle is the same: executors are swappable, tools are written against the interface.

### Iteration cap

- Default: 50 tool calls per agent loop
- If hit without `finish`, treat as failure, escalate

### Timeout

- Total wall-clock timeout per loop: 15 minutes (Weekend 1 default)
- If exceeded, kill loop, escalate

### System prompt structure

```
[voice.md contents]

---

You are working on a Linear ticket for 707 Labs. Your job is to understand what's needed, make the code changes, and stop when done.

Repo is at: {worktree_path}
Branch: {branch_name}
You can use tools to read, edit, and commit. When you're done, call finish() with a one-sentence summary of what you did.

Rules:
- Make the smallest change that solves the ticket
- If the ticket is ambiguous, make a reasonable choice and note it in finish()'s summary
- If you realize the ticket is bigger than you can handle, call finish() with a summary explaining what you did and what's left — escalation will happen automatically
- Run bash commands from the repo root; don't cd elsewhere
- Don't install new dependencies unless the ticket clearly requires it

---

Ticket: {ticket_identifier} — {ticket_title}

{ticket_description}

{ticket_comments if any}
```

---

## 11. State persistence

### SQLite schema

```sql
CREATE TABLE tickets (
  linear_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,       -- e.g. "MUL-142"
  classification TEXT,             -- 'CODE' | 'ANSWER' | 'BOUNCE' | NULL
  classification_confidence REAL,
  classification_scope TEXT,       -- 'S' | 'M' | 'L'
  classified_at TIMESTAMP,
  last_polled_at TIMESTAMP,
  terminal_state TEXT              -- 'merged' | 'bounced' | 'escalated' | NULL
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_linear_id TEXT NOT NULL,
  action_type TEXT NOT NULL,       -- 'classify', 'start_coding', 'fix_ci_failure', ...
  state_fingerprint TEXT NOT NULL, -- hash of the state Gary acted on
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  success BOOLEAN,
  error_message TEXT,
  FOREIGN KEY (ticket_linear_id) REFERENCES tickets(linear_id)
);

CREATE INDEX idx_actions_fingerprint ON actions(ticket_linear_id, state_fingerprint, action_type);

CREATE TABLE prs (
  github_id INTEGER PRIMARY KEY,
  ticket_linear_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  opened_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  merged BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (ticket_linear_id) REFERENCES tickets(linear_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ticket_linear_id TEXT,
  event_type TEXT NOT NULL,        -- 'poll', 'state_transition', 'action_dispatched', 'error'
  payload_json TEXT                -- arbitrary structured log
);
```

### Volume

SQLite file path: `${GARY_STATE_DIR}/gary.db` (default `~/.gary/state/gary.db`). This path is a mounted volume in Docker deployments, ensuring state survives container restarts.

### What's NOT in SQLite

- The current content of Linear tickets (fetched fresh each poll)
- The current content of GitHub PRs (fetched fresh each poll)
- CI status (fetched fresh)
- Anything derivable from Linear + GitHub

If SQLite is wiped, Gary recovers — he may re-comment on PRs he's already commented on, and he'll re-classify tickets. This is acceptable. **Design invariant: Gary must never lose data by losing SQLite.**

---

## 12. Configuration

### Environment variables

```
# Identity
GARY_LINEAR_USER_ID=<uuid>
GARY_NAME=Gary

# Linear
LINEAR_API_KEY=<key>
LINEAR_TEAM_ID=<team-uuid>        # Mulligan Labs team
LINEAR_IN_PROGRESS_STATE_ID=<id>  # state to move tickets to on pickup

# GitHub (app-based, default)
GITHUB_APP_ID=<id>
GITHUB_APP_PRIVATE_KEY=<pem-contents>
GITHUB_APP_INSTALLATION_ID=<id>
GITHUB_APP_USERNAME=gary[bot]

# GitHub (user-based, alternative)
# GITHUB_PAT=<token>
# GITHUB_USERNAME=gary-707labs

# GLM via Z.ai
Z_AI_API_KEY=<key>
Z_AI_BASE_URL=https://api.z.ai/api/anthropic
Z_AI_MODEL=glm-4.6

# Runtime
POLL_INTERVAL_MS=60000
MAX_ATTEMPTS_PER_TICKET=5
CIRCUIT_BREAKER_WINDOW_HOURS=6
MAX_CI_ATTEMPTS=3
AGENT_LOOP_MAX_ITERATIONS=50
AGENT_LOOP_TIMEOUT_MS=900000

# Paths
GARY_HOME=~/.gary
GARY_STATE_DIR=~/.gary/state
GARY_REPOS_DIR=~/.gary/repos
GARY_WORKSPACES_DIR=~/.gary/workspaces

# Repos (Weekend 1: just Ertai)
GARY_ALLOWED_REPOS=707-labs/ertai
```

### Secrets

Weekend 1: `.env` file, gitignored. Acceptable for local dev.
Later: move to 1Password / SOPS / whatever Tanner prefers. Not blocking.

---

## 13. Directory structure

```
gary/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── voice.md                        # SEE SEPARATE FILE — load at runtime
├── src/
│   ├── index.ts                    # entry point, starts the poll loop
│   ├── config.ts                   # env loading, validation
│   ├── loop.ts                     # the poll loop
│   ├── state/
│   │   ├── db.ts                   # SQLite wrapper
│   │   ├── schema.sql              # migrations
│   │   └── queries.ts              # typed query helpers
│   ├── adapters/
│   │   ├── linear.ts               # Linear API wrapper
│   │   ├── github.ts               # GitHub API wrapper (App + PAT)
│   │   └── glm.ts                  # GLM client (Anthropic SDK, Z.ai endpoint)
│   ├── executors/
│   │   ├── index.ts                # Executor interface + shared types
│   │   ├── local.ts                # LocalExecutor (Weekend 1)
│   │   └── docker.ts               # DockerExecutor (Weekend 2; stub + TODO in Weekend 1)
│   ├── handlers/
│   │   ├── classifier.ts
│   │   ├── code.ts
│   │   ├── answer.ts
│   │   ├── bounce.ts
│   │   └── ci-failure.ts
│   ├── agent/
│   │   ├── loop.ts                 # generic tool-calling agent loop
│   │   ├── tools.ts                # tool definitions and implementations
│   │   └── prompts.ts              # prompt composition (voice + task)
│   ├── priority.ts                 # action priority logic
│   ├── state-fingerprint.ts        # how to hash derived state
│   └── logger.ts
├── test/
│   ├── priority.test.ts
│   ├── state-fingerprint.test.ts
│   └── fixtures/
└── scripts/
    ├── setup-linear-user.md        # manual steps
    ├── setup-github-app.md         # manual steps
    └── demo.ts                     # runs the demo flow from §15
```

Use Bun as runtime and package manager. `bun run src/index.ts` starts Gary.

---

## 14. Error handling and escalation

### Retry policy

- Network errors to Linear/GitHub/Z.ai: exponential backoff, up to 5 retries per call
- Other errors: log and surface; do not retry

### Escalation triggers

- Agent loop hits iteration cap: escalate (comment explaining, reassign)
- Agent loop hits timeout: escalate
- CI fix failed `MAX_CI_ATTEMPTS` times: escalate
- Circuit breaker tripped: escalate
- Classifier returns low confidence (< 0.5): escalate with a "i wasn't sure how to classify this, kicking it back"

Escalation always:
1. Posts a voice-appropriate comment explaining what happened (see voice.md examples 12, 13)
2. Reassigns to the original assigner
3. Removes Gary from assignees
4. Marks ticket `terminal_state = 'escalated'` in SQLite

### Panic / unknown errors

If Gary crashes uncaught, the process should exit. Run Gary under a supervisor (systemd, pm2, or in Docker with `restart: unless-stopped`). On restart, Gary re-polls and picks up where he left off — state is in Linear + GitHub + SQLite, not in-memory.

---

## 15. Testing and acceptance

### Weekend 1 acceptance demo

This is the contract. If this demo runs end-to-end, Weekend 1 is done.

1. **Setup** (manual, one-time):
   - Gary Linear user exists, API key works
   - Gary GitHub App installed on `707-labs/ertai`
   - `.env` populated
   - `bun run src/index.ts` starts cleanly, SQLite initialized

2. **Demo ticket:** Create a real Linear ticket in Mulligan Labs team with a small, well-scoped task. Example: "Add a `GET /api/health` endpoint to ertai that returns `{ok: true, version: <package.json version>}`"

3. **Assign to Gary.**

4. **Within 2 minutes:** Gary comments "picking this up, triaging now" (or similar — voice-generated).

5. **Within 3 minutes:** Gary comments with classification: "classified as code. i'll open a PR..."

6. **Within 10 minutes:** Gary opens a PR on GitHub with:
   - Branch name `gary/mul-<N>-add-health-endpoint` (or similar)
   - Voice-appropriate PR description
   - Working code that actually adds the endpoint
   - A comment on the Linear ticket with the PR link

7. **Force a CI failure:** Push a commit to main that causes a test to fail on Gary's branch (or intentionally break something in his code). CI fails.

8. **Within 5 minutes of CI failing:** Gary pushes a commit fixing the failure. CI goes green.

9. **Merge the PR yourself** (Gary never merges his own). Gary comments "thanks, moving on" or similar on the Linear ticket. Ticket closes via GitHub's linking.

If all 9 steps happen without manual intervention beyond what's listed, Weekend 1 passes.

### Unit tests (minimum)

- `priority.ts`: given various derived states, correct action is selected
- `state-fingerprint.ts`: deterministic hashing, changes when state changes
- `classifier.ts`: given fixture tickets, returns expected classifications (use real GLM calls, cached fixtures)

### Manual verification checklist

- [ ] Gary's Linear comments sound like Gary (compare against voice.md examples)
- [ ] PR description sounds like Gary
- [ ] Commit message sounds like Gary
- [ ] No double-comments on the same state
- [ ] SQLite survives process restart
- [ ] Gary recovers gracefully from a wiped SQLite (re-polls, re-classifies, re-comments once — acceptable)

---

## 16. Explicit non-goals (do not build these Weekend 1)

- Docker sandboxing / VM isolation (interface yes, `DockerExecutor` no)
- VPS deployment
- Review comment response (humans)
- Review comment response (bots — Gemini reviewer integration)
- User report triage
- Multi-repo support
- Webhook receivers for Linear or GitHub (polling is fine)
- Rebase-on-main automation
- Stale PR nudging
- PR merge automation (Gary never merges his own — architectural, not Weekend-1-deferral)
- Metrics / observability beyond event log in SQLite
- Web dashboard
- Slack notifications
- Multi-model routing
- Prompt caching optimization
- Concurrent job execution
- A queue separate from Linear (Linear is the queue)

If Claude Code finds itself about to build any of these, stop and flag it to Tanner. Weekend 1 is about proving Gary works on the happy path, not building the full system.

---

## 17. Open questions for Tanner

These need answers before or during build:

1. **Linear team ID for Mulligan Labs** and **state ID for "In Progress"** — Tanner to pull these from Linear's API or UI and drop in `.env`
2. **Linear user ID for Gary** — created manually in Linear, ID pulled from API
3. **GitHub App registration** — Tanner creates the App in the 707 Labs org settings; Claude Code can help generate the manifest
4. **Ertai repo path** — confirm the full `owner/repo` string (spec assumes `707-labs/ertai`)
5. **Gary's avatar** — Tanner to provide an image; placeholder acceptable for Weekend 1
6. **Default PR reviewer** — when Gary opens a PR, should he request review from anyone specific (Tanner? Ben? no one)? Config option, but pick a default.
7. **Ticket state on classify** — which Linear state does Gary move tickets to when he picks them up? ("In Progress" is the usual answer, but state IDs vary per workspace.)

---

## 18. Build sequence suggestion

If executing this top-to-bottom is overwhelming, here's an order that gets to a demo fastest:

1. Scaffold project (package.json, tsconfig, env loading, SQLite init)
2. Linear adapter (fetch assigned issues, post comment, reassign)
3. GitHub adapter (App auth, clone, push, open PR, get CI status)
4. GLM adapter (basic chat + tool use via Anthropic SDK to Z.ai)
5. Executor interface + LocalExecutor (the abstraction tools will be built against)
6. Classifier handler (voice.md + classifier prompt → JSON)
7. Poll loop with priority calculation, classify-only (stop after step 6's output)
8. Agent loop (tools built on Executor, iteration cap, timeout)
9. CODE handler (worktree setup → LocalExecutor → agent loop → PR open)
10. CI failure handler
11. ANSWER and BOUNCE handlers
12. Circuit breaker and escalation
13. Run the §15 demo

Each step should be independently testable. Don't chain everything together before verifying individual pieces.

---

## Appendix A: Why GLM and not Claude

Gary uses GLM-5.1 via Z.ai, not Claude via Anthropic's API, for two reasons:

1. **Cost.** Tanner has a flat-rate GLM Coding Plan ($18/month). Agent workloads burn tokens; a flat plan makes the economics of "Gary runs 24/7" work.
2. **Independence.** Tanner's primary Claude Code workflow uses his Max 20x plan. Running Gary on Claude would either consume that quota or require separate API billing with variable cost.

If GLM quality turns out to be insufficient for a given handler, that specific handler can be routed to Claude via config. Don't build multi-model routing Weekend 1 — but design the GLM adapter so swapping the backend is a one-line change.

## Appendix B: Related resources

- voice.md (sibling file, required)
- Z.ai docs: https://docs.z.ai/devpack/overview
- Linear API: https://developers.linear.app/docs
- GitHub App docs: https://docs.github.com/en/apps
- Anthropic SDK (usable against Z.ai): https://github.com/anthropics/anthropic-sdk-typescript
