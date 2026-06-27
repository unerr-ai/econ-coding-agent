import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Z3 — S1.3: create session_canonical_state table for persisted ledger / scratchpad / attempts
export default {
  id: "20260627000001_s1_3_canonical_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_canonical_state\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`key\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`payload\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_canonical_state_session_id_fk\`
            FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_canonical_state_session_idx\` ON \`session_canonical_state\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_canonical_state_session_kind_seq_idx\` ON \`session_canonical_state\` (\`session_id\`, \`kind\`, \`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
