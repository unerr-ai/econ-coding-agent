import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

const CAUSE_SUMMARY_MAX_LENGTH = 200

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// Total, best-effort "<name>: <first message line>" summary of a defect, bounded to
// ~200 chars, for headless callers that can't read server logs. Never throws (unknown
// shapes fall back to undefined) and never surfaces stack traces, headers, or env values —
// those stay in the full Cause.pretty log line alongside the ref.
function summarizeCause(defect: unknown): string | undefined {
  try {
    if (defect === null || defect === undefined) return undefined
    if (typeof defect !== "object") {
      const text = String(defect).split("\n")[0]?.trim()
      return text ? truncate(text, CAUSE_SUMMARY_MAX_LENGTH) : undefined
    }
    const record = defect as Record<string, unknown>
    const name = typeof record.name === "string" ? record.name : undefined
    const nestedData = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : undefined
    const nestedMessage = typeof nestedData?.message === "string" ? nestedData.message : undefined
    const message = nestedMessage ?? (typeof record.message === "string" ? record.message : undefined)
    const firstLine = message?.split("\n")[0]?.trim()
    const summary = [name, firstLine].filter((part): part is string => Boolean(part)).join(": ")
    return summary ? truncate(summary, CAUSE_SUMMARY_MAX_LENGTH) : undefined
  } catch {
    return undefined
  }
}

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`
      const causeSummary = summarizeCause(error)

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
              cause: causeSummary,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer
