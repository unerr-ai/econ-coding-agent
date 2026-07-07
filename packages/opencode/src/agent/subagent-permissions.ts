import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies unless the subagent's OWN
 *    agent-level config grants them (OL-9.3d). A rule that only exists
 *    because the project's global `permission` block turned it on for
 *    every agent (e.g. `"permission": {"task": "allow"}`) does not count —
 *    otherwise that global default defeats the safety net for every
 *    persona/tier agent that never configured `task`/`todowrite` itself.
 *    Pass `globalPermission` (the same ruleset merged into every agent, e.g.
 *    `Permission.fromConfig(cfg.permission ?? {})`) so it can be excluded.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
  globalPermission?: PermissionV1.Ruleset
}): PermissionV1.Ruleset {
  const global = input.globalPermission ?? []
  const isOwnGrant = (permission: "task" | "todowrite") =>
    input.subagent.permission.some(
      (rule) =>
        rule.permission === permission &&
        !global.some(
          (g) => g.permission === rule.permission && g.pattern === rule.pattern && g.action === rule.action,
        ),
    )
  const canTask = isOwnGrant("task")
  const canTodo = isOwnGrant("todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
