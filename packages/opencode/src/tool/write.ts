import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { seedReadDedup } from "./_shared"
import {
  callersAtRiskWarning,
  isTestFilePath,
  testEditGateArmed,
  testEditDenialMessage,
  noEditsGateArmed,
  noEditsDenialMessage,
  rawTaskChildGateArmed,
  rawTaskChildDenialMessage,
  evaluateHubEditGate,
  hubEditGateArmed,
} from "./edit-governance"
import { isTestLikePath } from "./graph-tools"
import {
  detectReceiverMethodDivergence,
  detectFamilyConflictEvidence,
  addedLines,
  evaluateConventionDivergenceGate,
  hasDeniedConventionDivergence,
  markConventionDivergenceDenied,
  hasDeniedConventionDivergenceSecond,
  markConventionDivergenceDeniedSecond,
} from "./convention-divergence"
import { conventionDivergenceNudgeText, conventionDivergenceSecondDenyNudgeText } from "@/session/prompts/nudges"
import { publishSignalFx } from "@/session/signal-bus"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)

          // P3 no-edits gate: a plan-only turn ("propose, don't code")
          // denies every file write at the tool boundary.
          if (noEditsGateArmed(ctx.sessionID)) {
            throw new Error(noEditsDenialMessage(path.relative(instance.worktree, filepath)))
          }

          // P11c raw-task hygiene: a raw task-tool child is a read-only recon
          // lane — edit work routes through verified slice dispatch instead.
          if (rawTaskChildGateArmed(ctx.sessionID)) {
            throw new Error(rawTaskChildDenialMessage(path.relative(instance.worktree, filepath)))
          }

          // B3 no-test-edit gate: on a fix-shaped turn, overwriting an
          // existing test file is denied with the reason — writing a NEW
          // test file (a repro) falls through.
          if (exists && testEditGateArmed(ctx.sessionID) && isTestFilePath(filepath)) {
            throw new Error(testEditDenialMessage(path.relative(instance.worktree, filepath)))
          }

          // Hub-edit bounce gate: a first write to a file the graph shows is
          // one of the repo's most-imported modules is denied once, steering
          // toward the root-most layer; an identical retry passes. The gate
          // itself is logging-free — log here, at the call site, inside the
          // Effect.
          const hubGateResult = yield* Effect.promise(() =>
            evaluateHubEditGate({ sessionID: ctx.sessionID, filePath: filepath }),
          )
          if (hubGateResult.action === "deny" && hubGateResult.second) {
            yield* Effect.logWarning("hub_edit_gate_bounced_second", {
              "session.id": ctx.sessionID,
              file: path.relative(instance.worktree, filepath),
              definingSites: (hubGateResult.definingSites ?? []).join(", "),
            })
            yield* publishSignalFx({
              name: "hub_bounce_repeat",
              sessionID: ctx.sessionID,
              severity: "tail",
              decision: "defer",
              evidence: {
                file: path.relative(instance.worktree, filepath),
                definingSites: (hubGateResult.definingSites ?? []).length,
              },
            })
            throw new Error(hubGateResult.message)
          }
          if (hubGateResult.action === "deny") {
            yield* Effect.logWarning("hub_edit_gate_bounced", {
              "session.id": ctx.sessionID,
              file: path.relative(instance.worktree, filepath),
              importers: hubGateResult.importers,
            })
            yield* publishSignalFx({
              name: "hub_bounce",
              sessionID: ctx.sessionID,
              severity: "info",
              decision: "convert",
              evidence: {
                file: path.relative(instance.worktree, filepath),
                importers: hubGateResult.importers ?? null,
              },
            })
            throw new Error(hubGateResult.message)
          }
          if (hubGateResult.action === "allow" && hubGateResult.retried) {
            yield* Effect.logInfo("hub_edit_gate_passed_on_retry", {
              "session.id": ctx.sessionID,
              file: path.relative(instance.worktree, filepath),
            })
          }
          if (hubGateResult.action === "allow" && hubGateResult.definingSite) {
            yield* Effect.logInfo("hub_edit_gate_defining_site_allow", {
              "session.id": ctx.sessionID,
              file: path.relative(instance.worktree, filepath),
            })
          }

          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          // Convention-divergence gate: a first added `R.m(` call whose
          // receiver is already established in this file but never paired
          // with this method before is denied once per session (bounded to
          // ONE deny total, not per file) — armed only within the hub-edit
          // gate's own armed scope, skipped for brand-new file creation, run
          // AFTER the hub-edit gate allows so a hub bounce always takes
          // precedence.
          const conventionDivergence =
            hubEditGateArmed(ctx.sessionID) && exists && !isTestLikePath(filepath)
              ? detectReceiverMethodDivergence({
                  beforeContent: contentOld,
                  addedText: addedLines(contentOld, contentNew),
                })
              : null
          const familyConflictEvidence =
            conventionDivergence !== null
              ? detectFamilyConflictEvidence({
                  beforeContent: contentOld,
                  receiver: conventionDivergence.receiver,
                  method: conventionDivergence.method,
                })
              : null
          const conventionAction = evaluateConventionDivergenceGate({
            armed: hubEditGateArmed(ctx.sessionID),
            isTestPath: isTestLikePath(filepath),
            isNewFile: !exists,
            divergence: conventionDivergence,
            alreadyDenied: hasDeniedConventionDivergence(ctx.sessionID),
            familyEvidence: familyConflictEvidence,
            alreadyDeniedSecond: hasDeniedConventionDivergenceSecond(ctx.sessionID),
          })
          if (conventionAction === "deny") {
            markConventionDivergenceDenied(ctx.sessionID)
            yield* Effect.logInfo("convention_divergence_denied", {
              "session.id": ctx.sessionID,
              receiver: conventionDivergence!.receiver,
              method: conventionDivergence!.method,
              file: path.relative(instance.worktree, filepath),
            })
            yield* publishSignalFx({
              name: "convention_divergence",
              sessionID: ctx.sessionID,
              severity: "info",
              decision: "convert",
              evidence: {
                receiver: conventionDivergence!.receiver,
                method: conventionDivergence!.method,
                file: path.relative(instance.worktree, filepath),
              },
            })
            throw new Error(
              conventionDivergenceNudgeText(
                conventionDivergence!.receiver,
                conventionDivergence!.method,
                conventionDivergence!.receiverSites,
              ),
            )
          }
          if (conventionAction === "deny-second") {
            markConventionDivergenceDeniedSecond(ctx.sessionID)
            yield* Effect.logInfo("convention_divergence_denied_second", {
              "session.id": ctx.sessionID,
              receiver: conventionDivergence!.receiver,
              method: conventionDivergence!.method,
              file: path.relative(instance.worktree, filepath),
            })
            yield* publishSignalFx({
              name: "convention_divergence_repeat",
              sessionID: ctx.sessionID,
              severity: "tail",
              decision: "defer",
              evidence: {
                receiver: conventionDivergence!.receiver,
                method: conventionDivergence!.method,
                file: path.relative(instance.worktree, filepath),
              },
            })
            throw new Error(
              conventionDivergenceSecondDenyNudgeText(
                conventionDivergence!.receiver,
                conventionDivergence!.method,
                familyConflictEvidence!,
              ),
            )
          }
          if (conventionAction === "pass-retry") {
            yield* Effect.logInfo("convention_divergence_pass_on_retry", {
              "session.id": ctx.sessionID,
              receiver: conventionDivergence!.receiver,
              method: conventionDivergence!.method,
              file: path.relative(instance.worktree, filepath),
            })
          }

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          // Seed the read-dedup memo from the content we just wrote, so a
          // re-read of this file later in the session hits immediately
          // instead of waiting for a first read to populate the memo. A
          // subsequent formatter pass (below) can still change the on-disk
          // bytes; the seeded hash simply misses on the next read in that
          // case and the memo re-arms as usual — best-effort, never fails
          // the write.
          try {
            seedReadDedup({ sessionID: ctx.sessionID, filePath: filepath, content: contentNew, messageID: ctx.messageID })
          } catch {
            // best-effort only
          }

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          // S6.3 in-loop governance gate: non-blocking, fail-open callers-at-risk
          // warning for a breaking signature change (never rejects the write).
          const callersAtRisk = yield* Effect.promise(() =>
            callersAtRiskWarning(filepath, contentOld, contentNew),
          )
          if (callersAtRisk) output += `\n\n${callersAtRisk}`

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
