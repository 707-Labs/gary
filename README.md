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
- `bun run deploy` — push latest to the mini and reload the launchd service
- `bun run logs` — tail gary's stdout on the mini

## deploy path (mac mini)

gary runs as a user-level launchagent on the mini at
`~/Library/LaunchAgents/com.707labs.gary.plist`. logs land in
`~/Library/Logs/gary/{stdout,stderr}.log`. state at `~/.gary/`.

to ship changes:

```sh
git push                 # push to 707-Labs/gary
bun run deploy           # ssh mini → git pull → bun install → typecheck → reload launchd
```

the deploy script is idempotent. it uses `git pull --ff-only`, so it
refuses to advance if the mini's working tree has local changes.

to follow logs:

```sh
bun run logs
```

manual launchctl ops:

```sh
ssh mini 'launchctl bootout gui/$(id -u)/com.707labs.gary'
ssh mini 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.707labs.gary.plist'
ssh mini 'launchctl print gui/$(id -u)/com.707labs.gary | head'
```
