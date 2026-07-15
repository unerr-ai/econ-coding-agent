/**
 * Pre-classification secret redaction — strips common credential shapes (API keys, bearer
 * tokens, passwords, AWS keys, connection strings) from captured shell output right after
 * ANSI-strip, before anything else (git-status fast path, cloud parser, user filter DSL,
 * classify) sees the text, so no downstream strategy or transcript re-echoes a live secret.
 * Ported from unerr-cli src/proxy/shell-strategies/redact.ts (rule-array + apply-function
 * shape); this ruleset targets credentials specifically, not path/timestamp normalization.
 *
 * @sem domain=tool role=compressor
 */

/** Placeholder substituted for any matched credential. */
export const REDACTION_MARKER = "<redacted>"

export interface RedactRule {
  pattern: RegExp
  replacement: string
}

/** Built-in credential redactors. Order matters — more specific patterns first. */
const BUILTIN_RULES: RedactRule[] = [
  // AWS access key IDs (AKIA/ASIA/AGPA/AIDA/AROA/AIPA/ANPA/ANVA/ASCA + 16 alnum)
  {
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
    replacement: REDACTION_MARKER,
  },
  // AWS secret access key assignment (aws_secret_access_key = ... / : ...)
  {
    pattern: /\b(aws_secret_access_key)("?\s*[:=]\s*"?)[A-Za-z0-9/+=]{20,}/gi,
    replacement: `$1$2${REDACTION_MARKER}`,
  },
  // PEM private key blocks
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTION_MARKER,
  },
  // JWTs (header.payload.signature, base64url)
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: REDACTION_MARKER,
  },
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  {
    pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTION_MARKER,
  },
  // Slack tokens (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-)
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: REDACTION_MARKER,
  },
  // Authorization header (Bearer/Basic/Token <value>) — checked before the generic
  // bearer-anywhere rule below so the keyword is preserved once, not twice.
  {
    pattern: /(Authorization:\s*)(?:Bearer|Basic|Token)\s+\S+/gi,
    replacement: `$1${REDACTION_MARKER}`,
  },
  // Generic bearer token outside an Authorization header (e.g. echoed curl -H args)
  {
    pattern: /\b(Bearer|bearer)\s+[A-Za-z0-9\-_.~+/]{10,}=*/g,
    replacement: `$1 ${REDACTION_MARKER}`,
  },
  // Generic api key / access token / client secret assignment
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key)("?\s*[:=]\s*"?)[^\s"',}]+/gi,
    replacement: `$1$2${REDACTION_MARKER}`,
  },
  // password / passwd / pwd assignment
  {
    pattern: /\b(password|passwd|pwd)("?\s*[:=]\s*"?)[^\s"',}]+/gi,
    replacement: `$1$2${REDACTION_MARKER}`,
  },
  // Connection strings with embedded user:pass@host credentials — keeps the scheme and
  // username, drops only the password (postgres://user:<redacted>@host:port/db).
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):[^\s/@]+@/gi,
    replacement: `$1$2:${REDACTION_MARKER}@`,
  },
]

/** Apply built-in + optional extra redaction rules to raw output. Idempotent. Cheap. */
export function redactOutput(raw: string, extra?: readonly RedactRule[]): string {
  if (!raw) return raw
  let s = raw
  for (const r of BUILTIN_RULES) s = s.replace(r.pattern, r.replacement)
  if (extra) {
    for (const r of extra) s = s.replace(r.pattern, r.replacement)
  }
  return s
}

/** Expose builtin rules for testing/inspection. */
export function getBuiltinRedactRules(): readonly RedactRule[] {
  return BUILTIN_RULES
}
