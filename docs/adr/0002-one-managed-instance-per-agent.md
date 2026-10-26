---
status: accepted (revised 2026-10-26: environment, revision, namespace)
---

# One marked T3 provider instance per agent; prompt and environment read from the agent file

T3 Code starts every child with the fixed launch arguments of a provider instance, and `delegate_task` passes nothing else per call except the task text and a model choice. We decided that the sync writes one managed instance `<namespace><agent>` (production namespace `pi-`) per enabled global agent, marked with `config.managedBy` and `config.namespace` (T3 keeps unknown keys inside `config`). Static fields become launch arguments. The prompt and the agent's `env` values are not copied: `--system-prompt` points at the agent file, and the wrapper in the child removes the frontmatter and sets the environment values while it loads. Each instance carries a revision in its environment, so a child can detect that T3 started it with an older configuration.

## Consequences

- No credential from an agent file enters T3 settings, T3 clients or backups. Variables that Pi reads before any extension loads cannot be set this way; they are a gap.
- A change to static frontmatter needs a new sync; a launch on a stale instance is refused, and a child on an older revision returns a stale reply. Body and `env` edits apply without a sync.
- T3 shows every managed instance in its provider picker and runs model and command discovery for each one.
- Removed agents become disabled instances (old child threads stay readable); `--prune` deletes them.
- Namespaces keep live-test instances apart from the owner's instances.
- Project agents cannot map to global instances; they are out of scope for v1.

## Considered options

- Generated prompt files: rejected, copies go stale between syncs.
- Agent environment as instance `environment` entries: rejected, values are public in T3 settings and copied into backups.
- T3 secret store for environment values: rejected, change detection would need a keyed hash.
- A sync state file for ownership: rejected, the markers inside `config` survive T3 rewrites.
- One shared instance for all agents: rejected, T3 would show the wrong model and the child could not have per-agent tools and extensions.
