---
status: accepted (revised 2026-10-26: raw-delegation guard)
---

# Use T3 native tools to stop, continue and read children, and guard raw delegation

pi-subagents offers `subagent_kill` and `subagent_resume`. In T3 Code a child is a T3 thread, and T3 already has `task_cancel`, `t3_thread_send` and `task_status`. pi-subagents registers `subagent_kill` unconditionally, so the wrapper cannot reuse that name (ADR 0001). We decided not to map these tools: inside T3 the wrapper hides pi-subagents' kill and resume tools, and the `subagent` result tells the model which T3 tool to call with which id. A child asks for help with an end-turn caller ping: it ends its run with the message, the parent is woken, and the parent continues the same child thread with `t3_thread_send`.

Because `delegate_task` is itself a tool the model can call, the wrapper also guards it: in child threads a raw call passes only when it comes from the wrapper's own launch (checked through the nested call's parent id); in root threads a raw call to a managed instance is refused; leaves and exhausted budgets lose every bridge tool that starts threads or tasks.

## Consequences

- Prompts that name `subagent_kill` or `subagent_resume` are wrong inside T3; the launch result corrects them per launch.
- `task_status` on a finished task marks the result read and suppresses the wake; the result text warns about it.
- A message typed into a finished child thread also wakes the parent, and a continued child counts toward width.
- Root threads keep raw delegation to non-managed providers.
- The guard is a tool policy, not a sandbox. If Pi stops providing the nested call's parent id, the guard refuses raw delegation.

## Considered options

- New wrapper tools `t3_subagent_kill` and `t3_subagent_resume`: rejected, more code and still different names.
- Caller ping as a blocking T3 question card: rejected, the parent gets only a one-time notice.
- No guard: rejected, a leaf could delegate and bypass depth and width.
