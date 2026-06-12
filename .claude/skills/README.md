# Vendored Skills — Superpowers

These skills are vendored from **Superpowers** by Jesse Vincent (obra).

- Source: https://github.com/obra/superpowers
- Version: `5.1.0`
- License: MIT (see [LICENSE](LICENSE))

They are a complete, auto-triggering software-development methodology: brainstorming →
git worktrees → writing plans → subagent-driven / TDD execution → code review → finishing a branch,
plus systematic-debugging and meta skills.

## Why vendored (not installed as a plugin)

This repo pins a committed copy so every contributor who uses Claude Code in this
repo gets the same skills without per-machine plugin installs. The tradeoff: this
copy does **not** auto-update. To refresh, re-run the vendoring against a newer tag.

## Local modifications

One mechanical change was applied to make the skills work as **project skills**
(invoked by bare name via the `Skill` tool) rather than plugin-namespaced skills:

- `superpowers:<skill-name>` cross-references in skill bodies were rewritten to
  `<skill-name>`. (The `superpowers:` prefix only resolves when installed as a
  plugin; project skills are invoked by their bare frontmatter `name`.)
- The `using-superpowers/references/{gemini,codex,copilot}-tools.md` mapping docs
  were left untouched — there `superpowers:...` is descriptive content, not an
  invocation.

No skill *behavior* content (Red Flags tables, rationalization lists, "human
partner" language) was altered.

## How they auto-trigger

The `.claude/hooks/session-start` bootstrap (wired via `.claude/settings.json`,
`SessionStart` hook) injects the `using-superpowers` skill at session start, which
tells the agent to check for and invoke relevant skills before acting. Without that
hook registered, the skills are still present and can be invoked manually via the
`Skill` tool, but they will not fire automatically.
