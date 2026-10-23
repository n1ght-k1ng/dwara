## What this changes

<!-- One or two sentences. What was wrong, or what is now possible. -->

## Why

<!-- The reasoning, not the diff. If it fixes a bug, what made the bug possible. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes
- [ ] I have read [`CLA.md`](../blob/main/CLA.md) and I agree to it (first PR only)

If this touches a tool:

- [ ] No remote command is built by string concatenation — the tool returns `argv`
- [ ] A mutating tool defines `snapshot`, `verify` and `rollback`, with integration
      tests for success, verify-failure-triggers-rollback, and timeout
- [ ] Tool output passes through the redactor, and server output is wrapped as
      untrusted data

If this touches policy, approvals, the hook or the audit log:

- [ ] A test exists that fails without the change
- [ ] Precedence still holds: deny > require_approval > allow, and no override loosens
      `never` or `deny`

## What I am unsure about

<!-- Naming the weak point gets a PR reviewed faster, not slower. Delete if there is none. -->
