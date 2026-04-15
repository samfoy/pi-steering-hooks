/**
 * Steering Hooks — deterministic enforcement of agent rules.
 *
 * Converts prompt-based behavioral rules into before-tool hooks that
 * block violations with 100% reliability and zero token cost.
 *
 * Override mechanism: if a rule fires, the agent can retry with a
 * `# steering-override: <rule-name> — <reason>` comment in the bash
 * command. The override is allowed through but logged via appendEntry.
 *
 * Inspired by: https://strandsagents.com/blog/steering-accuracy-beats-prompts-workflows/
 *
 * Configuration:
 *   Place a `steering.json` in your project root or ~/.pi/agent/ to
 *   add custom rules or disable defaults. See README for format.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────

export interface Rule {
  name: string;
  tool: "bash" | "write" | "edit";
  /** Field to test — "command" for bash, "path" for write/edit, "content" for write */
  field: "command" | "path" | "content";
  /** Regex pattern string to match (violation = match) */
  pattern: string;
  /** Optional: only fire if this pattern also matches (AND condition) */
  requires?: string;
  /** Optional: don't fire if this pattern matches (exemption) */
  unless?: string;
  /** Message shown when blocked */
  reason: string;
  /** If true, no override allowed — hard block */
  noOverride?: boolean;
}

interface SteeringConfig {
  /** Disable specific default rules by name */
  disable?: string[];
  /** Additional custom rules */
  rules?: Rule[];
}

// ─── Default Rules (general-purpose) ───────────────────────────────

const DEFAULT_RULES: Rule[] = [
  {
    name: "no-force-push",
    tool: "bash",
    field: "command",
    pattern: "\\bgit\\s+push\\b.*--force",
    reason: "Force push rewrites remote history and can destroy teammates' work. Use `git push --force-with-lease` if you must, or better yet, create a new commit.",
  },
  {
    name: "no-hard-reset",
    tool: "bash",
    field: "command",
    pattern: "\\bgit\\s+reset\\s+--hard\\b",
    reason: "Hard reset discards uncommitted changes permanently. Use `git stash` to save work first, or `git reset --soft` to keep changes staged.",
  },
  {
    name: "no-rm-rf-slash",
    tool: "bash",
    field: "command",
    pattern: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+/(?:\\s|$)",
    reason: "Recursive force-delete from root is catastrophic. Specify a safe path.",
    noOverride: true,
  },
  {
    name: "conventional-commits",
    tool: "bash",
    field: "command",
    pattern: "\\bgit\\s+commit\\b.*-m\\s+[\"'](?!(feat|fix|style|refactor|docs|test|chore|perf|ci|build|revert)(\\(.+\\))?(!)?: )",
    reason: "Commit message must use Conventional Commits format: `type(scope): description`. Types: feat, fix, style, refactor, docs, test, chore, perf, ci, build, revert.",
  },
  {
    name: "no-long-running-commands",
    tool: "bash",
    field: "command",
    pattern: "\\b(npm\\s+run\\s+dev|npm\\s+start|yarn\\s+start|yarn\\s+dev|npx\\s+.*--watch|webpack\\s+(--watch|serve)|jest\\s+--watch|nodemon|tsc\\s+--watch)\\b",
    reason: "Don't run long-running dev servers or watchers from bash — they block the agent. Use the process tool or run it in a separate terminal.",
  },
];

// ─── Override Detection ────────────────────────────────────────────

function extractOverride(cmd: string, ruleName: string): string | null {
  const pattern = new RegExp(
    `#\\s*steering-override:\\s*${ruleName}\\s*[—–-]\\s*(.+)`,
    "i",
  );
  const match = cmd.match(pattern);
  return match ? match[1].trim() : null;
}

// ─── Config Loading ────────────────────────────────────────────────

function loadConfig(): SteeringConfig {
  const candidates = [
    join(process.cwd(), "steering.json"),
    join(process.env.HOME || "", ".pi", "agent", "steering.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch (err) {
        console.error(`[steering-hooks] Failed to parse ${path}: ${err}`);
      }
    }
  }
  return {};
}

function buildRules(config: SteeringConfig): Rule[] {
  const disabled = new Set(config.disable || []);
  const rules = DEFAULT_RULES.filter((r) => !disabled.has(r.name));
  if (config.rules) rules.push(...config.rules);
  return rules;
}

// ─── Rule Evaluation ───────────────────────────────────────────────

function testRule(rule: Rule, value: string): boolean {
  if (!new RegExp(rule.pattern).test(value)) return false;
  if (rule.requires && !new RegExp(rule.requires).test(value)) return false;
  if (rule.unless && new RegExp(rule.unless).test(value)) return false;
  return true;
}

// ─── Extension Entry Point ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const rules = buildRules(config);

  pi.on("tool_call", async (event, _ctx) => {
    for (const rule of rules) {
      // Match tool type
      if (rule.tool === "bash" && isToolCallEventType("bash", event)) {
        const cmd = event.input.command;
        if (!testRule(rule, cmd)) continue;

        // Check override
        if (!rule.noOverride) {
          const overrideReason = extractOverride(cmd, rule.name);
          if (overrideReason) {
            pi.appendEntry("steering-override", {
              rule: rule.name,
              reason: overrideReason,
              command: cmd,
              timestamp: new Date().toISOString(),
            });
            return;
          }
        }

        const overrideHint = rule.noOverride
          ? ""
          : ` To override, retry with: # steering-override: ${rule.name} — <reason>`;

        return {
          block: true,
          reason: `[steering:${rule.name}] ${rule.reason}${overrideHint}`,
        };
      }

      if (rule.tool === "write" && isToolCallEventType("write", event)) {
        const value = rule.field === "path" ? event.input.path : event.input.content;
        if (!testRule(rule, value)) continue;

        return {
          block: true,
          reason: `[steering:${rule.name}] ${rule.reason}`,
        };
      }

      if (rule.tool === "edit" && isToolCallEventType("edit", event)) {
        if (rule.field === "path" && testRule(rule, event.input.path)) {
          return {
            block: true,
            reason: `[steering:${rule.name}] ${rule.reason}`,
          };
        }
      }
    }
  });
}
