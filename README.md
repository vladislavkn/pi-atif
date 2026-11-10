# pi-atif

A [pi](https://github.com/earendil-works/pi) extension that saves the session log as an
[ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
(`ATIF-v1.8`) trajectory.

```bash
pi install /Users/vlad/Projects/personal/pi-atif   # permanently
pi -e /Users/vlad/Projects/personal/pi-atif        # one run
```

The trajectory is rewritten after every agent run and on exit, to
`~/.pi/agent/atif/<session-dir>/<session-name>/trajectory.json` (base directory overridable
with `PI_ATIF_DIR`). Images are stored in `images/` next to it. `/atif [path]` exports on demand;
`/resume` an old session and run `/atif` to convert it.

- `index.ts` – extension: when and where to write
- `atif.ts` – conversion from pi session entries to ATIF

## Mapping

| pi | ATIF |
|---|---|
| system message | `system` step; tools → `agent.tool_definitions` |
| user message | `user` step (images → file references) |
| assistant message | one `agent` step per LLM call: text, thinking → `reasoning_content`, tool calls, thinking level → `reasoning_effort`, usage → `metrics` |
| tool result | `observation` of the agent step that made the call |
| compaction / branch summary | `system` step with `extra.context_management` |
| extension message, `!cmd` | `user` step, `extra.pi.role` = `custom` / `bashExecution` |
| context edit | `extra.pi.context_edit` on the edited step |

`prompt_tokens` = input + cache reads + cache writes (ATIF counts cached tokens as part of the
prompt). `total_cost_usd` also includes summaries, cache warming and nested model calls of tools.
Only the active branch is exported. Each step has `extra.pi.entry_id` for tracing back to the session file.
