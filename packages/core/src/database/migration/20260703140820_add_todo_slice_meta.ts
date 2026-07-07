import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260703140820_add_todo_slice_meta",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`slice_meta\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
