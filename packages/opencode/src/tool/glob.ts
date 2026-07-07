import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

const GLOB_METACHARACTERS = /[*?[{]/

/**
 * Broadens a plain, metacharacter-free glob pattern that missed into a
 * recursive last-segment wildcard, so a bare filename/path guess still finds
 * near matches instead of forcing a manual retry.
 *
 * @sem domain=search role=pattern-broadening
 */
export function broadenPattern(pattern: string): string | undefined {
  if (GLOB_METACHARACTERS.test(pattern)) return undefined
  const lastSegment = pattern.split("/").pop() ?? pattern
  const broadened = `**/${lastSegment}*`
  return broadened === pattern ? undefined : broadened
}

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          let files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit })
          let truncated = files.length === limit

          let broadened: string | undefined
          if (files.length === 0) {
            broadened = broadenPattern(params.pattern)
            if (broadened !== undefined) {
              files = yield* ripgrep.glob({ cwd: search, pattern: broadened, limit })
              truncated = files.length === limit
            }
          }

          const output = []
          if (files.length === 0) {
            output.push(
              broadened === undefined
                ? "No files found"
                : `No files found for "${params.pattern}" (also tried "${broadened}")`,
            )
          }
          if (files.length > 0) {
            if (broadened !== undefined) {
              output.push(`[econ-ctx] no matches for "${params.pattern}" — auto-broadened to "${broadened}":`)
            }
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
              broadened,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
