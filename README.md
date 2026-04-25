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
