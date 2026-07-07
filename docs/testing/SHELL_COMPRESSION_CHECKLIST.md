# econ — Shell Output Compression Live-Testing Checklist

Real-world scenarios to verify econ's shell-output compression is working end-to-end, with lossy compression triggering only when appropriate and recovery paths intact. Each test confirms one concrete behavior: exact output strings, compression ratios, audit trails.

**How to reference tests:** Every test case carries an ID `<section>.<serial>` — the section number is the category, the serial is the test's position within it (e.g. **1.3** = Section 1, third test). Section headers are unnumbered; IDs run serially through the whole section.

**Section order = how often you run them.** Correctness invariants (failed test counts cannot disappear) come first; harder-to-verify behaviors (quality monitor state, lossy tee paths) sit below.

| # | Section | When you run it | Scope |
|---|---------|---|---|
| 1 | Correctness invariants | Every test run — observable in agent output | exit-code masking, failure signal survival |
| 2 | Compression & recovery behaviors | Daily during development | lossy tee, quality monitor, template mining, salience, git fast-path |

**Setup (no extra steps needed):** The compression fires automatically inside the `shell` tool. No `unerr exec --` prefix — that's unerr-cli's mechanism. Output is compressed before truncation (both live view and saved-file safety net activate on raw size).

---

# Section 1 — Correctness Invariants

These are the non-negotiable signal-survival tests. A failure here means the agent misled the user about the build state. Written as Prompt blocks — run them through the econ CLI / agent interface and verify the live output.

### 1.1: Failing test run — single segment with pipe

**Prompt:** `Run the code-intelligence tests for the double-pay module with `pnpm run test:run packages/code-intelligence/test/double-pay.test.ts 2>&1 | tail -50` and report the test state.`

**Expected:**
- Output shows a summary line with the real failed count: e.g. `vitest: 1 passed, 2 failed (duration)`
- The "N failed" count is preserved exactly (not collapsed away, not rounded)
- Exit code is non-zero (test failure propagates)
- Even though piped to `tail -50`, the summary line was not lost

**Red flags:**
- Output shows "vitest: 3 passed" with no failed count → failure signal was dropped
- Summary line missing entirely → compression strategy ate the tail
- Exit code is 0 (success) despite failures shown in stderr → masking bug

**How to verify in the audit trail:**
```bash
# Read the compression audit log (one JSONL line per compression event)
cat ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | tail -1 | jq .
# Fields to check:
#   "category": "test_results"
#   "ratio": should be high (>0.4) because failures are salient and kept
#   "confidence": reflects how sure the classifier is this is a test result
#   "command": contains "vitest" + "double-pay"
```

---

### 1.2: Failing test run — composite command with redirect and echo

**Prompt:** `Run this: \`pnpm run test:run packages/code-intelligence/test/econ-cost.test.ts; echo DONE && git status\` and report the full output.`

**Expected:**
- Output contains: the test result summary line
- Output contains: "DONE" from the echo
- Output contains: git status summary (modified/staged files)
- No masking of failure counts or exit status

**Red flags:**
- "DONE" is missing → segment was dropped
- git status output is missing → composite routing failed
- No test result line → classification picked wrong category for mixed output

**How to verify in the audit trail:**
```bash
# Composite commands skip single-strategy compression and use omni (dedup-only)
# Verify in the last audit line:
#   "category": "log_text" (omni falls back to log_text for audit purposes)
#   "confidence": should be lower for composite, or category reflects the first strong hint
#   Check that raw output size roughly equals returned size (omni does line dedup only)
```

---

### 1.3: All-pass test run — aggressive collapse expected





**Prompt:** `Run the tests for the econ-cost module: \`pnpm run test:run packages/code-intelligence/test/econ-cost.test.ts\` and show the result.`

**Expected (if all pass):**
- Output is a single line or two: e.g. `vitest: 5 passed (234ms)`
- Agent is confident the test suite passed (no hedging language)
- No per-test output, no "✓" checkmarks listed individually
- This compression is **desirable** — that's the good case

**Red flags:**
- Dozens of checkmark lines shown individually → compression did not trigger
- Per-test names and times listed out → strategy was skipped or miscategorized
- "N passed" is omitted from the summary → parser failed

**How to verify in the audit trail:**
```bash
cat ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | tail -1 | jq '{category, ratio, confidence, command}'
# Expected: high compression ratio (~0.05–0.15), high confidence, category=test_results
```

---

### 1.4: Lossy compression tee — recovery path activation

**Prompt:** `Run a command that produces >1KB of output but compresses ≥30%: \`find . -type f -not -path '*/node_modules/*' | head -100\` (or similar large command).`

**Expected:**
- Live output shown to agent is compressed (significantly shorter than raw)
- Agent sees a message appended: `[output compressed — full output: <file>]`
- The file path points to a valid file under `~/.unerr/…` or the project's temp dir
- Full uncompressed output exists in that file
- Agent can re-read the file without re-running the command

**Red flags:**
- No recovery message appended → lossy tee path is broken
- File does not exist or contains truncated output → save failed
- Agent sees the full uncompressed output (no compression applied) → threshold logic failed

**How to verify in the audit trail:**
```bash
# Lossy events are recorded same as any compression
#   "ratio": 0.6–0.7 (30–40% saved)
#   "command": contains the original command you ran
# Verify the file exists and is readable:
ls -lh $(tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq -r '.command' | grep -o '/tmp/[^"]*')
```

---

# Section 2 — Compression & Recovery Behaviors

Deeper per-feature verification. These test novel behaviors or edge cases. Some require examination of the audit log or adaptive-state file.

### 2.1: Quality monitor — conservative mode (re-run detection)

**Prompt (repeat 4× back-to-back, each as its own `opencode run` invocation, no edits in between):** `Run exactly this command: bun test pass.test.ts — then reply with one short line stating the pass/fail counts.`

**Fixture requirements (validated live 2026-07-05 — both bit us before being written down):**
1. **The test output must be genuinely large.** `bun test` detects a non-TTY and suppresses per-test ✓ lines — a bare all-pass summary is ~29 raw tokens and its compression ratio (~0.897) sits ON the 0.9 tracking-gate boundary, so events record only on byte-count luck. Use a fixture whose tests `console.log` a line each (60 tests → ~2.4KB stdout → one-liner at ratio ≈0.01, records every time).
2. **The command must be permission-allowed for the conductor.** Headless `opencode run` auto-denies any bash rule that evaluates to "ask" (the OL-9.0b backstop in `src/permission/index.ts`), and econ's default bash ruleset is `"*": "ask"` — the agent then never executes the command at all. Add `"bun test*": "allow"` under `permission.bash` in the test project's `opencode.json`.

**Expected progression (each run is a fresh process — this exercises cross-process hydration):**
- Run 1: aggressive one-liner (`bun_test: 60 passed (…)`); an audit line is appended; adaptive-state still empty (nothing to match yet)
- Run 2: hydrates run 1's pending event from the audit tail and matches it → `overCompressionCounts.test_results: 1`
- Run 3: match → count 2
- Run 4: third signal → count resets to 0 and `conservativeCategories: ["test_results"]` — the flip
- Post-flip runs: category routes to dedup-only omni; its gentler ratio sits above the 0.9 tracking gate, so audit lines stop appearing (passthroughs never re-signal — by design)

**Red flags:**
- Audit line count doesn't grow on runs that executed the command → compression isn't recording (check the ratio gate and that the command actually ran — see fixture requirement 2)
- Audit grows but counts never increment → cross-process hydration is broken (shell.ts must await `monitor.ready` before `noteCommandExecution`; a synchronous call races the disk read and always loses)
- Over-compression never flips conservative after 3 in-window matches → feedback loop is broken

**How to verify in the audit trail:**
```bash
# Check adaptive-state for counts + conservative flags:
cat ~/.local/share/opencode/shell-compress-quality/adaptive-state.json | jq '{overCompressionCounts, conservativeCategories}'

# Check the last 3 audit lines (JSONL — one object per line):
tail -3 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '{category, ratio, command}'

# Afterwards, clear the synthetic state so real sessions don't start in conservative mode:
rm -rf ~/.local/share/opencode/shell-compress-quality
```

**Known semantic:** matched pending events are consumed in-process but not tombstoned on disk, so a later fresh process can re-match a still-in-window audit entry an earlier process already matched. The over-compression signal is still truthful per process pair; revisit only if it ever over-triggers in practice.

---

### 2.2: Template mining — exemplar collapse with count

**Prompt:** `Run a command that emits dozens of lines with a repeated pattern (e.g., a compilation output with the same error repeated): \`(for i in {1..50}; do echo "error: file$i.rs:$(($RANDOM % 100)): undefined reference"; done)\`.`

**Expected:**
- If template mining is integrated: output collapses to exemplar form
  - First example shown verbatim
  - Remaining lines collapsed to a count marker: `exemplar line  [×N]` where N is the count
- Both **different error messages** (same shape) **and identical ones** are handled:
  - Identical lines: dedup with explicit count
  - Similar lines (differ in a variable part): grouped under an exemplar

**Red flags:**
- All 50 lines shown verbatim → template mining did not trigger
- All lines collapsed to a single count, losing the varied error messages → salience was not applied
- Exemplar is not shown (only the count) → user cannot see the pattern

**When verified at run time:** Mark exact output format below. This feature may land after the checklist is written.

**How to verify in the audit trail:**
```bash
# Template mining would create a new audit entry with a strategy field (if audit is extended):
tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '.category'
# Would show a category like "log_text" (template mining uses log_text + exemplar grouping)
```

---

### 2.3: Salience — failure lines survive progress compression

**Prompt:** `Run a long-running command with progress output interleaved with an error line (e.g., a build or download with a failure mid-stream): \`(for i in {1..20}; do [ $i -eq 10 ] && echo "ERROR: connection timeout"; echo "progress: $i/20"; sleep 0.1; done)\`.`

**Expected:**
- If salience is integrated: the ERROR line is **preserved verbatim in the output**, never silently dropped
- Progress lines (without error/fail keywords) may be compressed away or collapsed with counts
- The ERROR line survives because it matches a salience pattern (`\berrors?\b`, `\bfail(s|ed|...)\b`, `\b(exception|panic|fatal|...)\b`, etc.)
- Salient lines may only be deduplicated with explicit `[×N]` counts, never silently merged
- Output still shows significant compression (progress lines condensed, but error untouched)

**Red flags:**
- ERROR line is missing from compressed output → salience guard is broken
- All progress lines kept verbatim → salience did not gate the compression strategy
- Error is collapsed with a count `[×1 ERROR lines]` → salience check failed

**When verified at run time:** Mark exact output format below.

**How to verify in the audit trail:**
```bash
tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '.category'
# May show "progress_streaming" or "log_text" depending on what dominates the output
```

---

### 2.4: Git status fast-path — grouped summary collapse

**Prompt:** `Make a change to a file (e.g., `echo "test" >> README.md`) and then run \`git status\` in the repo.`

**Expected:**
- Output shows a grouped summary of modified/staged/untracked files (not listed line-by-line)
- Output size is ~70–85% smaller than raw `git status` output
- The summary preserves semantic meaning: e.g. `2 modified, 1 untracked` (counts, not individual files)
- No `_shell_fmt:` header (small outputs and fast-path outputs do not emit headers)

**Red flags:**
- Raw git status output shown verbatim (no compression) → fast-path detection failed
- File list is shown individually → compression bypassed
- Grouped summary is missing counts → parser failed

**How to verify in the audit trail:**
```bash
tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '.category'
# Should show "key_value" (git status uses the key_value strategy via the fast-path)
```

---

### 2.5: Never-inflate — minified output passes through

**Prompt:** `Run a command that outputs minified JSON or compact data: \`echo '{"data":[1,2,3],"metadata":{"count":3},"status":"ok"}' | jq -c .\` (or any very-compact output).`

**Expected:**
- Output is passed through **unchanged** (no compression applied, no inflation)
- No `[output compressed …]` message (compression did not trigger)
- Agent sees the exact JSON/data as returned
- Compression ratio is recorded as 1.0 (no change)

**Red flags:**
- Output is reformatted or wrapped → a strategy added whitespace (inflation)
- Compression ratio < 1.0 (shown as saved tokens) on an already-minimal input → compression inflated the output

**How to verify in the audit trail:**
```bash
tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '.ratio'
# Should be 1.0 (no compression applied)
# OR the command is so small it falls below the threshold and is not logged at all
```

---

### 2.6: Composite command — every segment output survives

**Prompt:** `Run a composite with multiple tools and a final tee: \`pnpm run test:run packages/code-intelligence/test/cache-meter.test.ts && echo "=== Tests done ===" && ls packages/code-intelligence/test/*.test.ts | head -5\``

**Expected:**
- Output contains the test result summary line (from pnpm)
- Output contains the "=== Tests done ===" marker (from echo)
- Output contains the file listing (from ls | head)
- All three segments' outputs are preserved in order
- No segment is dropped or silently merged

**Red flags:**
- One of the three outputs is missing → composite routing failed
- Outputs are mixed/reordered → segment boundaries were not tracked
- Only the first or last segment is shown → classification picked wrong category

**How to verify in the audit trail:**
```bash
tail -1 ~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl | jq '{category, confidence, command}'
# Composite commands route through omni (dedup-only), so category may show "log_text"
# and the command should reflect the composite structure with && separators
```

---

### 2.7: Multi-segment dedup — shared lines identified across segments

**Prompt:** `Run: \`echo "Processing..." && npm run build 2>&1 | grep -E "error|warning" | head -5 && echo "Done"\``

**Expected (if multi-region/multi-segment dedup is integrated):**
- Any line that appears in both the first echo and the build stderr is only shown once
- Line count is preserved but dedup is applied across segments
- Outputs are still clearly segmented (e.g., `── lines 1–5 · initial segment ──` header if multi-region headers are active)

**Red flags:**
- Same line appears twice (once in echo context, once in build output) → cross-segment dedup is broken
- Segment boundaries are lost → output is flattened incorrectly

**When verified at run time:** Mark exact output format below. This feature may land after the checklist is written.

---

### 2.8: Exit code preservation — failed command exit code never masked

**Prompt (internal verification):** Run a test or build that fails. Check that the exit code returned to the tool harness is non-zero, even when the output is compressed to a single line.

**Expected:**
- `exitCode` parameter in `compressShellOutput(command, stdout, stderr, exitCode)` is returned unchanged
- The agent sees failure signaling in the output (a salient line with "failed" or exit code)
- Shell tool does not mask the exit code (exit code comes from the process, not from compression)

**Red flags:**
- Exit code is 0 despite compressed output showing failure → exit code was overwritten
- Compressed output shows failure but exit code indicates success → misleading state

---

### 2.9: Truncation + compression interaction

**Prompt:** `Run a very long command that both compresses AND exceeds line/byte limits: \`find . -type f | wc -l && for i in {1..500}; do echo "line $i: $(date)"; done | head -400\``

**Expected:**
- Output shows compressed view (not all 400+ lines verbatim)
- If raw output exceeds limits: truncation flag is set, full output saved to file, and both messages are shown:
  - `...output truncated...` (from truncation safety net)
  - `[output compressed — full output: <file>]` (from lossy tee, if ratio < 0.7)
- The saved file contains the **raw combined output** (both stdout + stderr merged as they appear)
- File is large enough to hold all lines (not a truncated save)

**Red flags:**
- Only one recovery message shown → truncation and lossy tee did not both activate
- File is smaller than expected → output was not fully saved
- Compression is applied after truncation (should be before) → safety net ordering is wrong

---

# Audit Trail Format Reference

All compression events are logged to:
```
~/.local/share/opencode/shell-compress-quality/compression-quality.jsonl   (append-only, one event per line)
~/.local/share/opencode/shell-compress-quality/adaptive-state.json          (snapshot of state flags)
```

Each JSONL line is a `CompressionAuditEntry`:
```json
{
  "command": "pnpm run test:run packages/code-intelligence/test/receipt.test.ts",
  "category": "test_results",
  "confidence": 0.95,
  "rawTokens": 1500,
  "returnedTokens": 200,
  "ratio": 0.133,
  "savedPct": 86.7,
  "timestamp": 1720158602845
}
```

**Key fields to check in each test:**
- `category`: matches the expected strategy (test_results, log_text, key_value, etc.)
- `ratio`: compression ratio (returned / raw; <0.7 triggers lossy tee)
- `confidence`: how sure the classifier is (0–1)
- `savedPct`: (1 - ratio) × 100; target is ≥30% for lossy tee
- `timestamp`: ISO-like epoch milliseconds; use to correlate with command runs

**Adaptive state snapshot (`adaptive-state.json`):**
```json
{
  "overCompressionCounts": {
    "test_results": 2,
    "log_text": 1
  },
  "goodStreaks": {
    "test_results": 5
  },
  "conservativeCategories": ["test_results"]
}
```

When a category is in `conservativeCategories`, all compressions for that category fall back to omni (dedup-only) until the good streak decays it back out.

---

## Running the full checklist

1. **Quick smoke (5 min):** Run 1.1, 1.3, 2.1, 2.4 — these exercise the core paths.
2. **Full run (20 min):** All Section 1 tests (correctness), then 2.1–2.4 (common behaviors).
3. **Deep dive (40 min):** All tests + audit log inspection after each; verify state files exist and update correctly.

For CI: Run at least Section 1 after every commit to compression-related code. Section 2 is best verified manually after a feature lands.

---

## Verified format notes

The following format strings have been verified against the implementation:

- **2.2 (template mining):** Exemplar collapse uses the marker format `exemplar line  [×N]` where N is the count of grouped lines (including the exemplar). Salient lines (matching patterns like `\berrors?\b`, `\bfail(s|ed|...)\b`, etc.) are never grouped by masked template — each survives individually when salient, allowing distinct error messages sharing a shape to both appear in the output.

- **2.3 (salience integration):** Salient lines (matching `\berrors?\b`, `\bfail(s|ed|ure|ures|ing)?\b`, `\b(exception|panic|fatal|abort|segfault|traceback|assert(ion)?)\b`, `\bassertionerror\b`, `\bexit(ed)?\s+(with\s+)?code\s+[1-9]`, `[✗✕●]`, `\bdenied\b`) are preserved exactly and never silently dropped by any compression strategy. They may only be deduplicated with explicit `[×N]` occurrence counts (omni and log-text strategies consult `isSalientLine` before folding any line away).

- **2.7 (multi-region headers):** Composite command output is split into contiguous regions by content sniffing and each region is prefixed with a header: `── lines A–B · <category> ──` where A and B are 1-based line numbers into the raw stripped output (matching the tee-saved file for retrieval-on-demand). Unknown regions use the omni (dedup-only) strategy.
