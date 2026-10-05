# @dwara/plugin-claude-code

The Claude Code plugin for Dwara.

| Component                      | What it is                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `commands/`                    | `/diagnose`, `/fix`, `/harden`, `/rollback`, `/audit`                                          |
| `skills/investigating-a-host/` | How to work on a host: evidence first, smallest reversible change, read what the tool returned |
| `hooks/hooks.json`             | Registers the PreToolUse hook, which blocks raw SSH to managed hosts                           |
| `hook/`                        | A copy of `@dwara/hook`, bundled at build time                                                 |

## Why the hook is bundled

An installed plugin has no workspace beside it, so it cannot reference
`../hook/dist`. `pnpm build` copies the built hook in; `hook/` is a build
artifact and is gitignored.

The hook entry uses exec form — `"command": "node", "args": [...]` — rather than
a single shell string. `claude plugin validate` flags the string form, and it is
right to: an unquoted `${CLAUDE_PLUGIN_ROOT}` splits into two words if the
install path contains a space.

## Permission settings

Not shipped here. Allowing `read_*` and prompting for everything else is a
property of a project, not of the plugin, so `dwara init` writes it into that
project's `.claude/settings.json`. That is also why tool names carry their risk
class as a prefix: a permission rule can match `mcp__dwara__read_*` without
knowing which tools exist.

## Checking it

```bash
pnpm --filter @dwara/plugin-claude-code build
claude plugin validate packages/plugin-claude-code
claude plugin validate packages/plugin-claude-code/commands
claude plugin validate packages/plugin-claude-code/skills
```

Note that validating the plugin root checks the manifest and the hooks but
reports `contents: []` — it does not walk into `commands/` and `skills/`, so
those need validating separately.
