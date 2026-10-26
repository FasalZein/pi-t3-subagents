# pi-t3-subagents

Runs pi-subagents agent definitions as T3 Code child threads when Pi runs inside T3 Code.

## Language

### Agents and instances

**Agent definition**:
A pi-subagents agent file: frontmatter fields plus a body that is the agent's prompt.
_Avoid_: agent file, agent config, agent spec

**Global agent**:
An agent definition in the user's global agents folder. Only global agents run in T3 in v1.
_Avoid_: user agent

**Project agent**:
An agent definition inside a repository that overrides a global agent of the same name for that repository.
_Avoid_: local agent

**Managed instance**:
A T3 provider instance that the sync created for exactly one global agent and marked as its own.
_Avoid_: agent instance, pi-agent instance

**Main instance**:
The user's own Pi provider instance in T3 that runs top-level threads. The sync never edits it.
_Avoid_: default instance, base instance

**Stale instance**:
A managed instance whose T3 settings no longer match its agent definition.
_Avoid_: outdated instance, drift

**Sync**:
The operation that brings the managed instances in line with the global agents.
_Avoid_: install, generate, refresh

### Delegation

**Takeover**:
Inside a T3 Pi session, the replacement of pi-subagents' launch tool by the T3 version of the same tool.
_Avoid_: override, shim

**Parent thread**:
The T3 thread whose agent launched a child.
_Avoid_: caller session, parent pane

**Root**:
A parent thread that runs on the main instance and so has no agent definition.
_Avoid_: top-level agent, main agent

**Child thread**:
The T3 thread in which a launched agent runs. It shows its lineage to the parent thread.
_Avoid_: pane, subagent session, helper process

**Delegated task**:
T3's record of one child run that a parent thread requested, with a task id and a final status.
_Avoid_: job, subagent run

**Wake**:
The message T3 sends to a parent thread when a delegated task reaches a final status.
_Avoid_: callback, steer message, result delivery

**Caller ping**:
A child's request for help that it sends as its final reply. It ends the child's run and wakes the parent thread, which then continues the same child thread.
_Avoid_: question card, interrupt

**Live children**:
The delegated tasks of one parent thread that the parent has not yet seen finish.
_Avoid_: slots, running subagents

**Spawn budget**:
The number of further nesting levels a child may still use to launch its own children.
_Avoid_: depth counter

### Fields

**Gap**:
An agent-definition field that has no effect in T3. Each gap is documented.
_Avoid_: unsupported option, limitation
