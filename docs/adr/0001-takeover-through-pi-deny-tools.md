---
status: accepted (revised 2026-10-26: fail-soft)
---

# Take over pi-subagents' launch tool through PI_DENY_TOOLS, and fail soft

Inside T3 Code the wrapper must replace pi-subagents' `subagent` tool. Pi 1.4.0 stops at startup when two extensions register the same tool name during load, so a plain second registration is not possible. We decided: while it loads (before pi-subagents, because command-line extensions load before settings packages), the wrapper adds `subagent` and `subagent_resume` to `PI_DENY_TOOLS`; pi-subagents reads that variable once in its factory and skips those tools. At session start the wrapper restores the original value and registers its own `subagent` only if no foreign `subagent` is registered. If one is (the suppression failed, for example after a pi-subagents update), the wrapper registers nothing, deactivates pi-subagents' launch tools in T3, and tells the user; the session keeps working without delegation.

## Consequences

- The suppression depends on pi-subagents internals, not on a Pi API. A change there no longer stops T3 Pi sessions; it disables delegation with a notice, and `/t3-subagents-doctor` names the broken contract.
- pi-subagents registers `subagent_kill` without checking the variable, so the wrapper cannot take that name (ADR 0003); it deactivates it in T3.
- Installing this repository a second time (as a settings package as well as through launch arguments) can still load two copies at load time, which is fatal. The README warns against it.
- The fail-soft path needs a real-Pi negative probe before it is trusted (first slice).

## Considered options

- Fail-stop (the first version of this ADR): rejected by the owner; a pi-subagents update must not stop T3 sessions.
- Same tool name registered first ("first registration wins"): rejected, a duplicate name at load is fatal in Pi 1.4.0.
- Instance `environment` entry for `PI_DENY_TOOLS`: rejected as the only mechanism, because the sync does not manage the main instance.
- A different tool name: rejected, agent prompts use `subagent`.
