# Take over pi-subagents' launch tool through PI_DENY_TOOLS

Inside T3 Code, the wrapper must replace pi-subagents' `subagent` tool. Pi 1.4.0 stops at startup when two extensions register the same tool name, so a second registration is not possible. We decided that the wrapper adds `subagent` and `subagent_resume` to the `PI_DENY_TOOLS` environment variable while it loads, before pi-subagents loads, and restores the original value when the session starts. pi-subagents reads that variable once in its extension factory and then skips those tools. The wrapper is loaded only through T3 instance launch arguments, because command-line extensions load before settings packages.

## Consequences

- This depends on pi-subagents internals, not on a Pi API: the factory-time read of `PI_DENY_TOOLS`, and the extension order. If pi-subagents changes either, every T3 Pi session stops at startup with a duplicate-tool error. Re-check after each pi-subagents or Pi update.
- pi-subagents registers `subagent_kill` without checking the variable, so the wrapper cannot take that name (see ADR 0003).
- Installing this repository as a settings package as well as through launch arguments can load two copies and cause the duplicate-tool error.

## Considered options

- Same tool name registered first ("first registration wins"): rejected, a duplicate name is fatal in Pi 1.4.0.
- Instance `environment` entry for `PI_DENY_TOOLS`: rejected as the only mechanism, because the sync does not manage the main instance.
- A different tool name: rejected, agent prompts and the pi-subagents roster use `subagent`.
