# One marked T3 provider instance per agent, prompt read from the agent file

T3 Code starts every child with fixed launch arguments of a provider instance, and `delegate_task` passes nothing else per call except the task text and a model choice. We decided that the sync writes one managed instance `pi-<agent>` per enabled global agent, marked with `config.managedBy = "pi-t3-subagents"` (T3 keeps unknown keys inside `config`). The agent's static fields become launch arguments and environment entries. `--system-prompt` points at the agent file itself, and the wrapper in the child removes the frontmatter before the first model request, so no prompt copies exist.

## Consequences

- A change to static frontmatter needs a new sync. The wrapper refuses to launch on a stale instance. A change to the agent body applies to the next child without a sync.
- T3 shows every managed instance in its provider picker and runs model and command discovery for each one.
- Removed agents become disabled instances (old child threads stay readable); `--prune` deletes them.
- Project agents cannot map to global instances; they are out of scope for v1.

## Considered options

- Generated body-only prompt files: rejected, copies go stale between syncs.
- A sync state file to track ownership: rejected, the marker inside the instance config is enough and survives T3 rewrites.
- One shared instance that reads the agent name from the task: rejected, T3 would show the wrong model and the child could not have per-agent tools and extensions.
