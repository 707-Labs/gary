# gary

ai agent at 707 labs. picks up linear tickets, opens prs, fixes ci.

see `GARY_SPEC.md` for the full build spec and `voice.md` for personality.

## setup

```sh
bun install
cp .env.example .env
# fill in: LINEAR_API_KEY, LINEAR_TEAM_ID, LINEAR_IN_PROGRESS_STATE_ID,
#         GARY_LINEAR_USER_ID, GITHUB_APP_* (or GITHUB_PAT), Z_AI_API_KEY
bun run start
```

state is in `~/.gary/` by default (sqlite db, bare clones, worktrees). override
via `GARY_HOME`, `GARY_STATE_DIR`, `GARY_REPOS_DIR`, `GARY_WORKSPACES_DIR`.

## scripts

- `bun run start` — start gary
- `bun run dev` — start gary with file watching
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — run unit tests
- `bun run deploy` — install, typecheck, test, pin HEAD as the release and restart the launchd service
- `bun run logs` — tail gary's stdout log

## deploy path (this mac)

gary runs on the development mac as the user-level launchagent
`com.707labs.gary` (`~/Library/LaunchAgents/com.707labs.gary.plist`); there is
no remote host. logs land in `~/Library/Logs/gary/{stdout,stderr}.log`. state at
`~/.gary/`.

the installed plist is rendered from `scripts/com.707labs.gary.plist`, which
carries the full runtime environment (Hermes executor pins, Slack config paths
and content hashes). `__GARY_RELEASE__` becomes the current HEAD. startup
(`src/readonly-startup.ts`) refuses to run unless HEAD equals that pin and no
tracked file is modified, so edits without a commit and redeploy crash-loop with
`readonly_release_mismatch`.

to ship changes:

```sh
git commit …             # the pin is HEAD; the tree must be clean
bun run deploy           # install → typecheck → bun test → render plist → bootout/bootstrap → wait for "gary booted"
git push origin main     # after the deploy verified
```

`bun run deploy -- --skip-tests` skips the suite. the script exits non-zero if
the agent does not log `gary booted`, or logs `shared conversation unavailable`
(config fingerprint or budget problem).

manual launchctl ops:

```sh
launchctl bootout gui/$(id -u)/com.707labs.gary
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.707labs.gary.plist
launchctl print gui/$(id -u)/com.707labs.gary | head
```

## security

gary is a weekend project that runs in production for exactly one linear
workspace (two humans). read this before running your own:

- **Hermes isolation.** the opt-in Hermes runtime uses pinned Docker workers
  without network, host credentials or workspace mounts. Admitted workspace
  actions use a separate reviewed Docker executor. The legacy local executor
  is still a different runtime and must not be confused with this deployment.
- **Host-owned authority.** credentials, canonical action ownership, request
  reservations, review and publication remain on the host. Project memory and
  repository text do not grant execution, access or spending authority.
- **acts immediately.** `bun run start` polls linear and acts on real tickets
  assigned to gary right away. point him at a test team first.
- **Untrusted inputs.** ticket text, repository content and learned notes are
  data. Hermes host tools enforce the admitted repository, action and fetch
  policy; model instructions cannot widen those permissions.
- **log redaction is narrow.** only `x-access-token:` urls are scrubbed from
  logs; secrets echoed in bash output are not.
- the mention allowlist defaults closed — unknown senders are ignored.

Project-aware Slack conversations and scoped persistent learning are described
in [project-assistant.md](docs/project-assistant.md). Deployment receipts, not
this README, establish which opt-in capabilities are currently active.
