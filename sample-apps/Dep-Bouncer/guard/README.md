# Agent install guard

This dependency-free Node 18+ hook checks explicit npm registry package installs and
package runners with Dep Bouncer before an agent's shell command runs. BLOCK denies
the command, REVIEW asks for user approval, and ALLOW permits it. Reports include
findings and any suggested safe version. A known BLOCK still denies a command if
another package check is unavailable.

## Claude Code

Add to a project's `.claude/settings.json` or `~/.claude/settings.json` (merge with
existing hooks). Replace the absolute path with your checkout's path:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node /path/to/dep-bouncer/guard/dep-bouncer-guard.mjs" } ] } ] } }
```

## Cursor

Add to `.cursor/hooks.json`:

```json
{ "version": 1, "hooks": { "beforeShellExecution": [ { "command": "node /path/to/dep-bouncer/guard/dep-bouncer-guard.mjs --cursor" } ] } }
```

Quote paths containing spaces inside the command string (escape double quotes as
`\"` in JSON). On Windows, forward slashes work in the Node script path.

## Configuration

- `DEP_BOUNCER_URL`: MCP endpoint override. Defaults to
  `https://dep-bouncer-6ad22414-giberelin-heapify-global-community.app.nitrocloud.ai/mcp`.
- `DEP_BOUNCER_FAIL_CLOSED=1`: ask for approval on unavailable, timed-out, or
  invalid responses. Default behavior allows the command and warns on stderr.

Set these in the environment inherited by the agent. Checks run in parallel with
a 25-second timeout per request. Configure the host hook timeout above that if
needed. At most eight distinct name/spec pairs are checked per command; split
larger batches into separate commands so each package is checked.

## Coverage

Handles explicit `npm install` aliases, `pnpm add/install/i`, `yarn add`,
`bun add/install/i`, and `npx`, `npm exec/x`, `pnpm dlx`, `yarn dlx`, `bunx`.
It respects quoted arguments and shell separators, leading environment assignments
and `sudo`, common flags with values, scoped packages, versions/ranges/tags, and
`npm:` aliases. Runners check explicit `--package` arguments or the first package
argument, without treating the invoked program's arguments as dependencies.

Bare `npm install` and `npm ci` from a lockfile are not checked; use the
`bouncer_check_manifest` tool. Local paths, Git URLs, repository shorthands, tarballs,
and other non-registry specs are skipped. This is a command parser, not a shell
interpreter: scripts, shell wrappers, substitutions, dynamically constructed commands,
transitive dependencies, other package managers, and alternate terminal tools are
outside its coverage. It checks a requested range/tag before execution; it does not
pin the eventual registry resolution or rewrite the command.

Example denied command: `npm i axios@1.14.1` → `Dep Bouncer BLOCK axios@1.14.1: Suspicious release. Install axios@1.14.0 instead.`
