import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createMemo, Show } from "solid-js"
import { getContextFullness, shouldNudgeCompaction } from "../../util/context-usage"

const id = "internal:session-footer-countdown"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  // Same reconciled fullness math as the sidebar Context panel (see
  // feature-plugins/sidebar/context.tsx) — surfaced here so the countdown is
  // visible even when the sidebar is closed.
  const fullness = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    const last = messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) return undefined
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return getContextFullness({
      tokens: last.tokens,
      model,
      compaction: props.api.state.config.compaction,
    })
  })

  const percent = createMemo(() => fullness()?.percentUntilCompact)

  // AC-4.3: proactive nudge at compaction.nudge_pct (default 0.80) of usable
  // context — offer /compact, a checkpoint, or narrowing scope before
  // auto-compaction or context rot hits. Dismissing only re-arms once fill
  // grows past the percent it was dismissed at, so it doesn't nag on every
  // render but still re-fires as the window keeps filling.
  const nudgeKv = () => `nudge_dismissed_pct:${props.session_id}`
  const dismissedAt = createMemo(() => Number(props.api.kv.get(nudgeKv(), 0)))
  const nudge = createMemo(() => {
    const f = fullness()
    if (!f) return false
    if (!shouldNudgeCompaction(f, props.api.state.config.compaction)) return false
    return (f.percentOfUsable ?? 0) > dismissedAt()
  })

  return (
    <>
      <Show when={nudge()}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().warning}>
            Context {fullness()?.percentOfUsable}% full — try <span style={{ fg: theme().text }}>/compact</span>,
            checkpoint, or narrow scope.
          </text>
          <text
            fg={theme().textMuted}
            onMouseDown={() => props.api.kv.set(nudgeKv(), fullness()?.percentOfUsable ?? 0)}
          >
            [dismiss]
          </text>
        </box>
      </Show>
      <Show when={percent() !== null && percent() !== undefined}>
        <text fg={theme().textMuted}>
          Context left until auto-compact: <span style={{ fg: theme().text }}>{percent()}%</span>
        </text>
      </Show>
    </>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
