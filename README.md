# pi-steering-hooks

Deterministic tool-call guardrails for [pi](https://github.com/badlogic/pi-mono). Enforce rules with before-tool hooks instead of prompts — zero token cost, 100% reliability.

Prompt-based rules ("never force push") work most of the time. Steering hooks work every time. They intercept tool calls before execution and block violations deterministically, with an override escape hatch for when the agent has a good reason.

Inspired by [Strands Agents: Steering Accuracy Beats Prompts](https://strandsagents.com/blog/steering-accuracy-beats-prompts-workflows/).

## Install

```bash
pi install @samfp/pi-steering-hooks
```

## Default Rules

| Rule | Tool | What it blocks |
|------|------|---------------|
| `no-force-push` | bash | `git push --force` (destructive history rewrite) |
| `no-hard-reset` | bash | `git reset --hard` (discards uncommitted work) |
| `no-rm-rf-slash` | bash | `rm -rf /` (catastrophic, no override allowed) |
| `conventional-commits` | bash | Non-conventional `git commit -m` messages |
| `no-long-running-commands` | bash | Dev servers and watchers that block the agent |

## Override Mechanism

When a rule fires, the agent can retry with an override comment:

```bash
git push --force origin main  # steering-override: no-force-push — deploying hotfix to unblock prod
```

The override is allowed through but logged to the session for audit. Rules with `noOverride: true` (like `no-rm-rf-slash`) cannot be overridden.

## Custom Rules

Create `steering.json` in your project root or `~/.pi/agent/`:

```json
{
  "disable": ["conventional-commits"],
  "rules": [
    {
      "name": "no-git-push",
      "tool": "bash",
      "field": "command",
      "pattern": "\\bgit\\s+push\\b",
      "reason": "Use `cr` instead of `git push`."
    },
    {
      "name": "aws-requires-profile",
      "tool": "bash",
      "field": "command",
      "pattern": "\\baws\\s+[a-z]",
      "unless": "(--profile|AWS_PROFILE=|\\baws\\s+(sts\\s+get-caller-identity|configure)\\b)",
      "reason": "Always use --profile or AWS_PROFILE with aws CLI commands."
    },
    {
      "name": "no-write-env-files",
      "tool": "write",
      "field": "path",
      "pattern": "\\.env",
      "reason": "Don't overwrite .env files — they may contain secrets.",
      "noOverride": true
    }
  ]
}
```

### Rule Format

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique rule identifier |
| `tool` | `"bash"` \| `"write"` \| `"edit"` | Which tool to intercept |
| `field` | `"command"` \| `"path"` \| `"content"` | Which input field to test |
| `pattern` | string | Regex — if it matches, the rule fires (violation) |
| `requires` | string? | Additional regex that must also match (AND condition) |
| `unless` | string? | Regex exemption — if this matches, rule doesn't fire |
| `reason` | string | Message shown to the agent when blocked |
| `noOverride` | boolean? | If true, no override escape hatch |

### Config Locations

Checked in order (first found wins):

1. `./steering.json` (project root)
2. `~/.pi/agent/steering.json` (global)

## How It Works

1. Extension registers a `tool_call` hook
2. On every bash/write/edit call, rules are evaluated against the tool input
3. If a rule matches: block the call and return the reason to the agent
4. Agent sees the block message and adjusts its approach
5. If the agent has a legitimate reason, it can retry with `# steering-override: rule-name — reason`
6. Overrides are logged via `appendEntry` for audit

No tokens spent on rule enforcement. No prompt drift. No "oops, the model forgot the rule this time."

## License

MIT
