import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260706172829_add_todo_parent_id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`todo\` ADD \`parent_id\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
