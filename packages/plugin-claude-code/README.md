# @dwara/plugin-claude-code

Claude Code plugin for Dwara. Contents land in **Phase 4** (see `docs/PLAN.md`):

- slash commands: `/diagnose`, `/fix`, `/harden`, `/rollback`, `/audit`
- an investigation skill (evidence first, smallest reversible fix, verify, summarise)
- `hooks.json` registering the PreToolUse hook from `@dwara/hook`
- permission settings: `read_*` tools allowed, everything else prompts

This package ships static assets only — there is nothing to build.
