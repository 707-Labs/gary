# Project skill discovery

`loadSkillIndex` reads direct `SKILL.md` children of both `.agents/skills/`
and `.claude/skills/` in the admitted project workspace. Existing coding,
answer, CI and PR handlers receive the combined index through their existing
project-context loader. No tool, credential, network or model permission is
added by discovery.

Each returned entry retains its exact project-relative source path. Entries
are sorted by name and then path using a stable lexical comparison. Identical
or conflicting names in different directories remain separate; neither root
overrides the other. The rendered menu shows both paths so an agent can read
the intended source with its existing scoped `read_file` tool.

Discovery accepts ordinary directories and single-link regular files. It
rejects symlink roots, symlink skill directories, linked skill files, unsafe
path characters and observed identity changes during a read. The workspace
root is canonicalized for OS path aliases such as `/tmp`; a workspace root
that is itself a symlink is rejected. This is bounded metadata discovery,
not a filesystem sandbox against another process continuously mutating the
workspace. Existing executor and repository admission boundaries still apply.

Each root is limited to 256 directory entries; an oversized or inaccessible
root is omitted in full while the other root can still load. Individual skill
files must be at most 256 KiB. Only the first 8 KiB plus a boundary byte are
read, and complete frontmatter must fit within 8 KiB. `name` and `description`
must each occur once as nonempty, single-line fields, bounded to 64 and 1,024
UTF-8 bytes respectively. LF and CRLF are accepted. Other frontmatter fields
are ignored. This loader does not implement general YAML or load skill bodies.
Missing, malformed, oversized or redirected skills are omitted without
preventing valid siblings from loading.

`loadProjectContext`'s CLAUDE.md/AGENTS.md handling is unchanged by this seam.
Skill metadata describes project conventions; it does not grant execution,
publication, spending or credential authority.
