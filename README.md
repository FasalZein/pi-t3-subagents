# pi-t3-subagents

A Pi extension that runs your pi-subagents agents inside T3 Code as T3 child threads.

In a terminal, pi-subagents starts each agent as a hidden process or a terminal pane. Inside T3 Code those children are invisible: they have no thread, no "Subagent of" lineage, and T3 does not wake the parent when they finish. This extension replaces pi-subagents' `subagent` tool in T3 Pi sessions. Each launch becomes a T3 child thread, started through T3's own `delegate_task`, from the same agent files and with the same rules. Outside T3 Code the extension changes nothing, and pi-subagents works as before.

The extension never edits T3 Code, Pi or pi-subagents install files. It writes only the T3 settings entries that it owns. So you can update all three tools independently; after an update, run the doctor (see "Compatibility contracts and the doctor").

Spec: [docs/specs/t3-subagents.md](docs/specs/t3-subagents.md). Vocabulary: [GLOSSARY.md](GLOSSARY.md). Decisions: [ADR 0001](docs/adr/0001-takeover-through-pi-deny-tools.md) (takeover), [ADR 0002](docs/adr/0002-one-managed-instance-per-agent.md) (one managed instance per agent), [ADR 0003](docs/adr/0003-t3-native-lifecycle-tools.md) (T3 lifecycle tools and the raw-delegation guard), [ADR 0004](docs/adr/0004-spawn-budget-in-task-header.md) (spawn budget in a task header), [ADR 0005](docs/adr/0005-direct-settings-write-with-narrow-window.md) (settings write and its risk).

## How it works

- **Main instance.** Your T3 Pi provider instance (id `pi` by default) loads this extension with `--extension`. In its threads, the extension hides pi-subagents' `subagent`, `subagent_resume` and `subagent_kill`, and registers its own `subagent` tool. If it cannot take over (for example, a pi-subagents update stops honoring `PI_DENY_TOOLS`), the session still works without delegation and shows a notice ([ADR 0001](docs/adr/0001-takeover-through-pi-deny-tools.md)).
- **Managed instances.** `/t3-sync-agents` creates one T3 provider instance per enabled global agent, with id `pi-<agent>` and display name `Pi <agent>`. The agent's static fields become Pi launch arguments. The instance loads this extension first ([ADR 0002](docs/adr/0002-one-managed-instance-per-agent.md)).
- **Launch.** The T3 `subagent` tool checks the pi-subagents rules (allowed models, `visible-to`, `spawning`, `spawn-depth`, `spawn-width`), then calls T3's `delegate_task` on the agent's managed instance. T3 shows the child thread with "Subagent of" lineage and wakes the parent with the child's final reply.
- **Child runtime.** In the child, the same extension sets the agent's `env` values, removes the frontmatter from the prompt, checks that the instance revision is the one the parent expected, and runs the caller ping, the context warnings and the time limit.

## Requirements

- T3 Code with the Pi provider and its MCP bridge (`T3_MCP_URL`). Tested with T3 Code Nightly 0.1.3-nightly.20261026.3710.
- Pi 1.4.0 or newer.
- pi-subagents with your agents in the global agents folder (`~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/`). Project agents (`<project>/.pi/agents/`) are not supported; a launch of one fails with a clear error.

## Setup

1. **Get a copy at a stable path.** Clone this repository to a folder that you do not edit, for example:

   ```sh
   git clone https://github.com/FasalZein/pi-t3-subagents.git ~/.pi/agent/t3-subagents/release
   ```

   No install step is needed: Pi supplies the Pi API and `typebox` to extensions. Use a separate checkout for development, so that work in progress does not reach your T3 threads.

2. **Load the extension in your main instance.** In T3 Code, open the settings of your Pi provider instance and add this to its launch arguments, with the absolute path of your copy (T3 does not expand `~`):

   ```
   --extension /Users/you/.pi/agent/t3-subagents/release/index.ts
   ```

   You can also edit `~/.t3/userdata/settings.json` directly: `providerInstances.<your Pi instance>.config.launchArgs`. Keep a backup. Load the extension only this way. Do not also install it as a Pi package or add it to Pi's settings: two copies cannot both own the takeover, and the doctor reports C2 as FAIL.

3. **Sync your agents.** Start a new thread on the main instance and run:

   ```
   /t3-sync-agents
   ```

   The sync shows the planned changes and asks for confirmation (see "Sync"). Without a UI (for example `t3 thread start`), add `--yes`. T3 loads the new instances after a few seconds.

4. **Check.** Run `/t3-subagents-doctor` in a main-instance thread. Every contract should be PASS (see "Compatibility contracts and the doctor").

5. **Launch.** Ask the model to use an agent, for example "Use the subagent tool to launch scout with the task ...". The parent model also gets a hidden roster that lists the agents it may launch.

## Sync

`/t3-sync-agents [--prune] [--yes] [--break-lock]` turns each enabled global agent into a managed instance.

- It plans one action per agent: add, update, unchanged, disable, prune (only with `--prune`), conflict, or skip with a reason. The plan, the warnings and the gaps are shown before anything is written. A second sync without changes reports "up to date" and writes nothing.
- A removed or disabled agent's instance becomes `enabled: false`, so its old threads stay readable. `--prune` deletes managed instances that are already disabled.
- It changes only instances that it owns (`config.managedBy = "pi-t3-subagents"` and the matching `config.namespace`). An instance with a planned id that it does not own is reported as a conflict and left alone. It never changes the main instance; it warns when the main instance does not load this extension.
- It never writes your agent `env` values or the prompt into T3 settings. The child reads both from the agent file at runtime, so prompt edits apply without a sync. Changes to other fields (model, tools, extensions, skills and so on) need a sync.
- Before each changing write it saves a backup in `~/.pi/agent/t3-subagents/backups/` (folder mode 0700, files 0600, the newest 10 are kept). To undo a sync, copy the newest backup over `~/.t3/userdata/settings.json`.
- You can run it from a T3 Pi thread or from a terminal Pi session that loads the extension.
- Skipped agents and gaps: an invalid name (only `A-Z a-z 0-9 _ -`, id at most 64 characters), an unknown skill, a T3-reserved launch flag in `flags` (`--mode`, `--session`, `--session-id`, `--no-session`, `--resume`, `--continue`, `--fork`, `--print`, `--export`, `--help`, `--list-models`, `--version`), or an `env` key that Pi reads before extensions load.
- Lock: the sync takes a lock file next to the settings file. If a sync crashed and left its lock, the sync stops and names the lock; run `/t3-sync-agents --break-lock` once. A lock whose holder process is still alive is never removed.

Environment variables (on the main instance, all optional): `PI_T3_SETTINGS_PATH` (default `~/.t3/userdata/settings.json`), `PI_T3_NAMESPACE` (instance id prefix, default `pi-`), `PI_T3_AGENTS_DIR` (default: the global agents folder).

### Settings-write risk

T3 Code locks its own settings writes only inside its own process, and it offers no settings route that an extension can use. So the sync writes `settings.json` directly, in the narrowest window it can: it re-reads the file, compares it with the version it planned from, and renames a temporary file over it at once. After T3 reloads, the sync reads the file again and checks every planned entry ([ADR 0005](docs/adr/0005-direct-settings-write-with-narrow-window.md)).

The remaining risk: a T3 settings save (for example, you change a setting in the T3 UI) in the same moment as the sync can be lost, or can erase the sync. The sync detects the second case and tells you to run it again. It cannot detect the first case. Do not change T3 settings while a sync runs, and keep the backups. There is also a small accepted window in `--break-lock`: a file system has no compare-and-delete, so a new sync that takes the lock in the same instant can lose it; that sync then finds that it no longer owns the lock and does not write.

## Field mapping

"Launch" = instance launch arguments (written by the sync). "Parent" = checked by the `subagent` tool in the parent thread. "Child" = done by the extension in the child.

| Field | In T3 |
|---|---|
| `name` | Launch: instance id `pi-<name>`, display name, `PI_T3_AGENT`. |
| `description` | Parent: roster entry. Agents without a description are not in the roster. |
| `model`, `thinking` | Launch: `--model`, `--thinking`. Parent: without them the child inherits the parent's model and thinking. |
| `allow-model-override` | Parent: when `false`, a `model` or `thinking` parameter is ignored. |
| `allowed-models` | Parent: an override outside the list fails before launch; the agent's own model is always allowed. |
| `tools` | Launch: `all` or absent: no flag. `none`: `--no-builtin-tools`. A list: `--tools` plus `caller_ping`; agents that may spawn also keep `subagent` and the T3 bridge tools `delegate_task`, `task_status`, `task_cancel`, `t3_thread_send`. |
| `deny-tools` | Launch: `--exclude-tools`. Leaves also lose `subagent` and every T3 tool that starts a thread. |
| `extensions` | Launch: `all` or absent: no flag. `none` or a list: `--no-extensions`, this extension, Pi's built-in MCP and tool-search, then each entry. |
| `skills` | Launch: `none`: `--no-skills`. A list: `--no-skills` plus `--skill <path>` each. An unknown skill skips the agent. |
| `inject-skills` | Parent: each skill is put into the first message, as in pi-subagents. |
| `system-prompt` | `replace`: `--system-prompt <agent file>`. `append`: `--append-system-prompt <agent file>` (or appended by the child with `inherit-append-system: true`). The child removes the frontmatter. Absent: the body goes into the first message as a role block. |
| `inherit-append-system` | Launch: `false` gives `--append-system-prompt ""`. |
| `env` | Child: set while the extension loads, before later extensions and tools. Never written to T3 settings. |
| `mode`, `auto-exit` | Parent: choose the mode hint. `mode: interactive` with `auto-exit` not `true` gets the interactive hint: the user can open the child thread and reply. No process exit in T3. |
| `async` | Parent: `true` (default): returns at once and the completion wakes the parent. `false`: the launch waits (up to the agent `timeout`, at most 60 minutes) and returns the reply inline. |
| `timeout` | Child: the run is stopped at the limit; T3 status `interrupted`. |
| `timeout-warn-threshold` | Child: one wrap-up message before the limit. |
| `context-warn-threshold`, `context-warn-step` | Child: wrap-up messages as in pi-subagents. |
| `spawning`, `spawn-depth`, `spawn-width` | Parent: enforced as in pi-subagents. Depth is exact: the remaining budget travels in a header line of the first message ([ADR 0004](docs/adr/0004-spawn-budget-in-task-header.md)). Width counts live children, including continued ones; root width is 16. |
| `visible-to` | Parent: launch check and roster filter. |
| `trust-project` | Launch: `--approve` for interactive agents with `trust-project: true`, else `--no-approve`. |
| `no-context-files` | Launch: `--no-context-files`. |
| `task-expansion: shell` | Parent: shell blocks in the task are expanded before launch (30 seconds per command). |
| `enabled` | Sync: `false` disables the instance. Parent: launch error. |
| `flags` | Launch: appended last. A T3-reserved flag skips the agent. |

### Gaps

These fields and behaviors have no T3 meaning, or T3 does not allow them. The sync lists them once per agent that uses them.

- `session-mode: fork`: the child starts fresh. `lineage-only` is native.
- `report-context-usage`: T3 owns the wake text.
- `cwd`, `deny-env`, `no-session`, `idle-timeout`, `on-timeout`, `parent-close-policy`, and the `llm-as-a-verifier` fields (`llm-as-a-verifier`, `-candidates`, `-model`, `-criteria`): not supported.
- Skill annotations `=auto` and `=manual` are removed; the skill is loaded normally.
- `env` keys that Pi reads before any extension loads (for example `PI_CODING_AGENT_DIR`, `PI_OFFLINE`): the child sets them too late. The sync reports them.
- Project agents: not supported (global agents only).
- Models that use the `openai-completions` API: T3's bridge activates its whole tool catalog for such a child, so that completion gateways do not drop calls to undeclared tools. Leaves still lose the thread-starting tools (`--exclude-tools`), and the guard still refuses them. To narrow the tools, give the agent a fixed `tools` list.
- The interactive hint is used only for `mode: interactive`; an agent without `mode` is treated as background.
- `pi-subagents`' `subagent_resume` and `subagent_kill`: hidden and blocked in T3 (use the T3 tools below).

## Lifecycle with T3 tools

Each launch result names the task id and the child thread id, and states one of four states:

| State | Meaning |
|---|---|
| `running` | Async child. Its completion wakes the parent; end your turn. |
| `finished` | The reply is in the result; no wake will come. |
| `waiting` | A synchronous child waits for an answer or an approval in its thread. The user answers there; the parent ends its turn and the child's final reply wakes it. |
| `wait_timed_out` | A synchronous wait reached its limit; the child still runs and its completion wakes the parent. |

Use T3's tools, not pi-subagents' tools:

- Stop: `mcp__t3-code__task_cancel {taskId}` (in codemode `tools.mcp__t3_code__task_cancel`).
- Continue a finished child in the same thread: `mcp__t3-code__t3_thread_send {threadId: childThreadId, message}` (`tools.mcp__t3_code__t3_thread_send`). The new run wakes the parent again and counts toward width.
- Read: `mcp__t3-code__task_status {taskId}` (`tools.mcp__t3_code__task_status`). Reading a finished result marks it read, and T3 then does not send its wake.

Wakes: T3 wakes the parent with `Delegated task <taskId> (<title>) [<status>]:` and the child's last reply (at most 16,000 bytes per wake; longer reports belong in files). A child stopped by its `timeout`, or by the user with "Stop generation", gives `[interrupted]` and `Child task ended with status interrupted.`, without a reply. A message that you type into a finished child thread also wakes the parent.

Questions: when a child asks a question (`ask_user` shows a question card in the child thread), T3 tells the parent. The user answers in the child thread. The parent must not ask the question again or relay it; it ends its turn and gets the child's final reply as a wake.

Raw delegation: children cannot call `delegate_task` directly, and cannot use T3's other thread-starting tools (`create_threads`, `t3_thread_launch`, `t3_thread_fork`, `schedule_task`, `run_scheduled_task_now`, `update_scheduled_task`). They start children only through `subagent`, so that `spawning` and the budget hold. Root threads keep raw `delegate_task` for providers that are not managed instances. This is a tool policy, not a sandbox: a child that can edit files can change its own agent file.

## Caller ping

A managed child has a `caller_ping {message}` tool. Use it when the child needs a decision from its caller and can continue afterwards in the same thread.

1. The child calls `caller_ping`. Every further tool call in that run is refused.
2. The child ends its turn with a final reply that starts with the line `CALLER PING`, followed by the message.
3. T3 wakes the caller with that reply. The caller decides (or asks its user) and continues the child with `t3_thread_send`. The child keeps its context.

## Supervised modes

A child inherits the runtime mode of its parent thread and cannot exceed it. In `Supervised` (approval-required) mode, observed live on T3 Code Nightly 2026-10-26:

- In the parent thread, one launch asks for approval of the `subagent` call, and then of the `mcp__t3-code__delegate_task` call that it makes. That is two approvals per launch. The second card shows the full first message and the target instance. If the model calls `subagent` from a codemode script, the codemode call needs one more approval first.
- The child thread opens in `Supervised` mode too. It asks for approval of its own commands and file changes in its own thread. The parent thread shows an "Open approval" button for the waiting child.
- An async parent gets no wake while a child waits for an approval. Open the child thread and answer there. The parent is woken when the child finishes.

## Compatibility contracts and the doctor

The extension depends on behavior of T3 Code, Pi and pi-subagents that can change in an update. `/t3-subagents-doctor` lists each contract with PASS or FAIL. Outside T3 it reports "not inside T3" and checks nothing.

| Id | Contract | What breaks, and what you see |
|---|---|---|
| C1 | pi-subagents skips `subagent` and `subagent_resume` when `PI_DENY_TOOLS` names them | The takeover fails soft: no delegation in that session, a notice, C1 FAIL. |
| C2 | Pi loads command-line extensions first; duplicate tool names at load are fatal | C2 FAIL names every loaded copy. Load the extension only through `--extension`. |
| C3 | T3 bridge tools `delegate_task`, `task_status`, `task_cancel`, `t3_thread_send` exist and are callable | Launch error naming the missing tool. |
| C4 | `delegate_task` input and result shape | The doctor shows the last launch outcome; launch errors carry the raw result. |
| C5 | T3 wake text format | Width accounting stops (fails open) with a notice; safety rules stay enforced. |
| C6 | T3 settings shape | The sync refuses to write and names the unexpected shape. |
| C7 | T3 launch argument rules and reserved flags | The agent is skipped, or T3 marks the instance unavailable. |
| C8 | Pi extension API features (prompt sections, input transform, nested tool call ids, active tools) | The feature is disabled with a notice; the raw-delegation guard refuses (fails closed). |
| C9 | pi-subagents frontmatter rules (copied from pi-subagents cf6dbf4) | C9 FAIL names agent files that are unreadable or use a field that this extension does not know. The parser rules are not checked automatically. |
| C10 | T3 reloads changed instances asynchronously | A launch on an instance that differs from its agent file is refused ("run /t3-sync-agents"); a child started on an older revision replies with a stale message. C10 FAIL lists the instances a sync would change. |

## Updates

- After an update of T3 Code, Pi or pi-subagents, run `/t3-subagents-doctor` in a main-instance thread and in a child thread (for example with `t3_thread_send` to a finished child). Fix every FAIL before you rely on delegation.
- After a pi-subagents update, also compare its agent format with the field mapping above (C9).
- To update this extension: move your stable copy to the new version (`git -C <copy> fetch && git -C <copy> checkout <tag or commit>`), start a new main-instance thread, and run `/t3-sync-agents`. Running threads keep the old code until their Pi process restarts.
- After you change an agent file (other than its body), run `/t3-sync-agents` and wait a few seconds before you launch it. A launch before the sync is refused; a launch in the seconds after it can return the stale message, so launch again.

## Development

See [AGENTS.md](AGENTS.md) for the checks (typecheck, unit tests with a fake Pi host and a fake T3 bridge, real-Pi probes) and the live-test rules.
