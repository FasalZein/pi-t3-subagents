# Use T3 native tools to stop, continue and read children

pi-subagents offers `subagent_kill` and `subagent_resume`. In T3 Code a child is a T3 thread, and T3 already has `task_cancel`, `t3_thread_send` and `task_status`. pi-subagents registers `subagent_kill` unconditionally, so the wrapper cannot reuse that name (ADR 0001). We decided not to map these tools: inside T3 the wrapper hides pi-subagents' kill and resume tools, and the `subagent` result tells the model which T3 tool to call with which id. A child asks its caller for help with an end-turn caller ping: it ends its run with the message, the parent is woken, and the parent continues the same child thread with `t3_thread_send`.

## Consequences

- Prompts and agent bodies that name `subagent_kill` or `subagent_resume` are wrong inside T3; the launch result corrects them per launch.
- `task_status` on a finished task marks the result as read and suppresses the wake. The result text warns about this.
- A message typed into a finished child thread also wakes the parent.

## Considered options

- New wrapper tools `t3_subagent_kill` and `t3_subagent_resume`: rejected, more code and still different names.
- Caller ping as a blocking T3 question card: rejected, the parent gets only a one-time notice and the flow differs from pi-subagents.
