# Spec: pi-t3-subagents (full wrapper)

Status: approved by the owner on 2026-10-26, revised the same day after a plan review (verdict NEEDS-CHANGES, 10 findings). Delivery tickets are GitHub issues in FasalZein/pi-t3-subagents, created from the slices in this file by `to-tickets`.

Vocabulary: `GLOSSARY.md`. Lasting decisions: `docs/adr/0001` to `0005`.

Baseline: commit 18a907e (spike wrapper plus docs). Versions observed: Pi 1.4.0, T3 Code Nightly 0.1.3-nightly.20261026.3710, pi-subagents cf6dbf4.

Evidence:

- Spike report: `~/.pi/artifacts/worker/t3-subagents-spike/report.md`
- pi-subagents field map: `~/.pi/artifacts/scout/t3-subagents-spec/pi-subagents-map.md`
- T3 Code facts: `~/.pi/artifacts/scout/t3-subagents-spec/t3-facts.md`
- Plan review: `~/.pi/artifacts/reviewer/t3-subagents-plan-review/report.md`

## Problem Statement

The owner runs Pi agents through pi-subagents. In a terminal, pi-subagents launches each agent as a hidden process or a terminal pane. Inside T3 Code, those children are invisible to T3: they have no thread, no lineage, and they do not use T3's completion wake.

T3 Code has its own delegation: a Pi thread can call `delegate_task` to start a child thread on a provider instance, and T3 wakes the parent when the child finishes. The spike proved this for one agent (scout) with a hand-written instance.

The owner wants every pi-subagents agent to work inside T3 Code as a T3 child thread, from the same agent definitions, with the same rules. It must work for any pi-subagents user. T3 Code, Pi and pi-subagents cannot be changed, and they must stay free to update: the wrapper exists so that nobody has to patch them.

## Solution

The pi-t3-subagents extension has four parts.

1. **Takeover.** In every T3 Pi session the extension replaces pi-subagents' `subagent` tool with a T3 version, and it fails soft: if the replacement is not possible, the session works without delegation and says why. Outside T3 Code the extension changes nothing.
2. **Sync.** `/t3-sync-agents` turns each enabled global agent into a managed instance in T3's settings. Static fields become launch arguments. Agent environment values and the prompt are read from the agent file by the child at runtime, so no secret or prompt copy enters T3 settings.
3. **Launch and child runtime.** The T3 `subagent` tool applies the pi-subagents rules (allowed models, visibility, spawning, exact depth, width) and starts children through `delegate_task`. In the child, the same extension sets the agent environment, removes frontmatter from the prompt, checks the instance revision, and runs the caller ping, context warnings and time limit.
4. **Compatibility.** Startup checks and `/t3-subagents-doctor` name each external contract that an update has broken.

Stopping, continuing and reading children use T3's native tools (`task_cancel`, `t3_thread_send`, `task_status`). Fields with no T3 meaning are documented gaps.

## User Stories

### Launch

1. As a T3 user, I want my parent thread to launch any enabled global agent with `subagent`, so that I use the same agents in T3 as in the terminal.
2. As a T3 user, I want each launched agent to run in its own T3 child thread with "Subagent of" lineage, so that I can open, read and steer it.
3. As a T3 user, I want the parent thread to wake when a child finishes, with the child's final reply, so that the parent continues without polling.
4. As a parent agent, I want a launch result that says whether the child is still running, already finished, or waiting for input, and whether a wake will come, so that I neither wait for a wake that never comes nor miss a result.
5. As a parent agent, I want a child that finished during the launch call to return its reply inline, so that the result is not lost.
6. As a parent agent, I want a launch to fail with a clear error when the agent does not exist, is disabled, is a project agent, or is not visible to me, so that I do not wait for a child that never starts.
7. As a parent agent, I want to pass a model or thinking override that the agent allows, so that I can pick a cheaper or stronger model per task.
8. As a parent agent, I want an override outside the agent's allowed models to fail before launch, so that agent policy holds.
9. As a parent agent, I want an override to be ignored when the agent forbids overrides, so that behavior matches pi-subagents.
10. As a parent agent, I want an agent without its own model or thinking to inherit mine, so that behavior matches pi-subagents.
11. As a parent agent, I want an `async: false` agent to block until the child finishes, and to get the live state when T3 stops waiting early (question, approval, wait limit), so that synchronous agents keep their contract as far as T3 allows.
12. As a parent agent, I want the child's first message built as in pi-subagents (injected skills, role block, mode hint, expanded task, summary instruction), so that agents behave the same in T3.
13. As a parent agent, I want shell blocks in the task expanded before launch for agents with shell task expansion, so that worker briefs keep working.
14. As a parent agent, I want a launch to refuse an instance whose T3 settings do not match the agent file, and tell me to run `/t3-sync-agents`, so that no child runs with an outdated configuration.
15. As a parent agent, I want a child that T3 started with an older instance revision to stop at once with a clear stale message, so that a just-synced change never runs silently on old arguments.
16. As a parent agent, I want an exact retry of a launch to return the original child, and a changed request to start a new child, so that retries neither duplicate work nor return the wrong child.
17. As a T3 user, I want the parent model to get an agent roster that lists the agents it may launch, with T3 lifecycle wording, so that the model knows which agents exist and how T3 children behave.
18. As a T3 user, I want one result shape for single launches and batches, so that scripts read it the same way.
19. As a T3 user, I want the launch tool not to produce a second native subagent card in the T3 UI, so that each child appears once.

### Batches and limits

20. As a parent agent, I want to launch several children in one `children[]` call, so that I can fan out work.
21. As a parent agent, I want the whole batch validated before any child starts, so that a bad entry does not leave half a batch running.
22. As a parent agent, I want all children of a batch started before any synchronous child is awaited, so that one synchronous child does not serialize the batch.
23. As a parent agent, I want to know which children already started when a later child fails to launch, so that I can manage the running ones.
24. As an agent author, I want `spawn-width` to cap my live children, including continued children, even when the model makes parallel tool calls, so that one agent cannot flood the host.
25. As a T3 user, I want width accounting to fail open with a notice when it cannot read T3's wake text, so that a T3 update does not block all delegation.
26. As an agent author, I want `spawning` to limit which agents my agent may launch, so that leaf agents stay leaves.
27. As an agent author, I want `spawn-depth` to narrow along the chain exactly as in pi-subagents, so that spawn cycles stop.
28. As an agent author, I want `visible-to` to hide an agent from callers that may not launch it, so that private helpers stay private.
29. As an agent author, I want an agent that may spawn to keep the T3 delegation tools even with a fixed tool list, so that nested launches work.
30. As an agent author, I want leaf agents and exhausted budgets to have no tool that starts threads or tasks, so that the rules hold.
31. As a T3 user, I want a raw `delegate_task` call from a child, and a raw call from a root thread to a managed instance, to be refused, so that the model cannot bypass the launch rules.
32. As a T3 user, I want my root threads to keep raw `delegate_task` for non-managed providers, so that other T3 delegation still works.

### Lifecycle

33. As a parent agent, I want the launch result to name the T3 tools and ids to stop, continue and read each child, so that I do not call pi-subagents tools that cannot work in T3.
34. As a parent agent, I want to stop a running child with `task_cancel`, so that I can abandon wrong work.
35. As a parent agent, I want to continue a finished child with `t3_thread_send`, so that the child keeps its context, and I want to be woken again when it finishes.
36. As a parent agent, I want to be warned that `task_status` on a finished task suppresses the wake, so that I do not lose results.
37. As a child agent, I want a `caller_ping` tool that sends my request to the caller, so that I can ask for a decision and continue in the same thread.
38. As a parent agent, I want a caller ping to arrive as a wake that I can recognize, so that I can relay the decision and continue the child.
39. As a T3 user, I want pi-subagents' `subagent_kill` and `subagent_resume` hidden in T3 sessions, so that the model does not call tools that cannot work there.

### Child runtime

40. As an agent author, I want my agent body to be the child's prompt without the frontmatter, and body edits to apply without a sync, so that prompt work is fast.
41. As an agent author, I want my agent's `env` values set in the child without being written into T3 settings or backups, so that credentials stay where I put them.
42. As an agent author, I want `context-warn-threshold` and `context-warn-step` to make the child wrap up before compaction, so that work is not lost.
43. As an agent author, I want `timeout-warn-threshold` to warn the child and `timeout` to stop its run, so that a stuck child does not run forever.
44. As an agent author, I want an interactive agent (architect, design) to run in a child thread where I answer its questions, so that grilling works in T3.
45. As a T3 user, I want `ask_user` questions from a child to appear as T3 question cards in the child thread, so that I answer them in the T3 UI.

### Sync

46. As a T3 user, I want `/t3-sync-agents` to create a managed instance for each enabled global agent, so that I do not edit T3 settings by hand.
47. As a T3 user, I want the sync to show the planned adds, updates, disables and conflicts and ask before it writes, so that I stay in control.
48. As a T3 user, I want a sync with no changes to say "up to date" and write nothing, so that repeated syncs are safe.
49. As a T3 user, I want private timestamped backups (last 10 kept) before each changing write, so that I can undo a bad sync.
50. As a T3 user, I want the sync to keep the window for a lost T3 settings save as small as possible, detect a lost sync after T3 reloads, and state the remaining risk, so that I know what the sync can and cannot promise.
51. As a T3 user, I want a removed or disabled agent's instance to become disabled, and `--prune` to delete disabled managed instances, so that old child threads stay readable until I clean up.
52. As a T3 user, I want the sync never to change an instance it does not own, and to report a name conflict instead, so that my own instances are safe.
53. As a T3 user, I want the sync to warn when my main instance does not load the extension, so that I know why takeover is missing.
54. As a T3 user, I want the sync to report skipped agents and gaps (invalid name, unknown skill, reserved launch flag, pre-extension environment variable), so that I can fix the agent file.
55. As a T3 user, I want to run the sync from a T3 Pi thread or from a terminal Pi session that loads the extension, so that I can sync where I work.

### Safety, updates and modes

56. As a T3 user, I want a failed takeover to leave the Pi session usable without delegation and to say why, so that a pi-subagents update never stops my T3 sessions.
57. As a T3 user, I want `/t3-subagents-doctor` to list each external contract and whether it still holds, so that I can check the wrapper after a T3, Pi or pi-subagents update.
58. As a T3 user, I want the wrapper never to edit T3, Pi or pi-subagents install files, and to write only the settings entries it owns, so that updates stay independent.
59. As a T3 user in a supervised mode, I want to know that one launch asks for approval twice, so that the second prompt does not surprise me.
60. As a T3 user, I want children to inherit my thread's runtime mode, so that a child never has more rights than its parent.
61. As a T3 user, I want the extension never to read the MCP bearer token, so that credentials stay inside T3's bridge.
62. As a terminal Pi user, I want the extension to change nothing outside T3, so that pi-subagents keeps working as before.
63. As a T3 user, I want processes started from a T3 Pi session not to inherit the takeover's tool denial, so that a `pi` started from bash behaves normally.
64. As the owner, I want my real T3 setup to load a pinned release copy, so that landed slices reach my T3 only at rollout.
65. As a pi-subagents user who is not the owner, I want a README that tells me how to install the extension and sync my agents, so that the wrapper works for my agents too.

## Implementation Decisions

### Owner decisions

| Id | Decision |
|---|---|
| D1 | All enabled global agents get a managed instance. The wrapper is universal: any pi-subagents agent definition must work. |
| D3 | The sync never edits the main instance. It warns when the main instance lacks the extension's launch argument. |
| D4 | Enforce `spawning`, `spawn-width` and `spawn-depth` as pi-subagents does. |
| D5 | Workers may run live T3 Nightly e2e checks without asking, under the hygiene rules in "Testing Decisions". |
| D6 | Live e2e runs use a dedicated scratch project, never a real project. |
| D7 | Stop, continue and status use T3 native tools. pi-subagents' kill and resume tools are hidden in T3 (ADR 0003). |
| D8 | Caller ping is an end-turn ping (ADR 0003). |
| D9 | Child runtime v1: context warnings, timeout warning and hard stop. Skill annotations `=auto` and `=manual` are a gap. |
| D10 | Spawn depth is exact: the remaining budget travels in a task header that the child strips (ADR 0004). |
| D11 | Width counts live children from events and reservations, never by polling `task_status`. |
| D12 | Removed or disabled agents: instance `enabled: false`. `--prune` deletes disabled managed instances. |
| D13 | A launch on an instance whose settings do not match the agent file is refused with "run /t3-sync-agents". |
| D14 | `--system-prompt` points at the agent file; the child strips the frontmatter (ADR 0002). |
| D15 | Sync confirms a diff and keeps timestamped backups in `~/.pi/agent/t3-subagents/backups/` (last 10). |
| D16 | Supervised modes: accept two approvals per launch; document it. |
| D17 | Interactive agents run as delegated child threads. Each finished run wakes the parent. |
| D18 | Global agents only in v1. Project agents get a clear error. Per-project instances are a deferred follow-up. |
| D19 | Settings write: narrowest window plus post-reload verification; the remaining race with a T3 settings save is documented, not hidden (ADR 0005). |
| D20 | `async: false`: when T3 stops waiting early, return the live state. A finished child returns its reply inline and says that no wake comes. Batches start all children first; synchronous children are awaited in parallel. |
| D21 | Continued children count toward width. A slot is reserved before each launch or send. |
| D22 | Raw `delegate_task` is refused in child threads unless it comes from the wrapper's own launch, and in root threads when it targets a managed instance. Leaves and exhausted budgets lose every bridge tool that starts threads or tasks. |
| D23 | Launch key = hash of the tool call id, the child index and the request before shell expansion. |
| D24 | Agent `env` values are set by the child wrapper while it loads; they never enter T3 settings or backups. Variables that Pi reads before any extension loads are a gap. |
| D25 | Live tests use an authorized namespace `t3e2e-<slice>-` per slice, fixture agents, and a test main instance that loads the slice worktree; teardown deletes the namespace. The `t3` CLI drives runs; the browser is used only for UI checks. |
| D26 | The owner's main instance and the spike `pi-scout` load a pinned release copy (applied 2026-10-26, see "Release pin"). |
| D27 | A final, authorized rollout slice switches the owner's real setup. |
| D28 | Child-side revision check: the child compares its instance revision with the revision the parent expects. |
| D29 | Takeover fails soft (ADR 0001). |
| D30 | The wrapper injects its own agent roster. |
| D31 | Update safety: never edit T3, Pi or pi-subagents install files; write only owned settings entries; startup checks plus `/t3-subagents-doctor`. |
| D32 | Broken accounting (an unreadable wake) fails open with a notice. Safety rules do not depend on T3 text and stay enforced. |
| D33 | Slice graph for parallel workers (see "Delivery Slices"). Build: one worker per slice, model cpa/claude-opus-5-5. |
| Seams | One main test seam (fake Pi host plus fake T3 bridge), real Pi probes, live T3 e2e. |

### Assumptions decided by the architect (routine, reversible)

| Id | Assumption |
|---|---|
| A1 | Effective model and thinking follow pi-subagents: override, else agent value, else the parent's value. If the effective pair equals the pair baked into the instance, the launch passes `model: "default"` and empty options. Otherwise it passes the concrete `provider/id` slug, plus `options.thinking` when the model supports thinking. |
| A2 | `delegate_task` gets no `role` (a role only adds a prompt prefix). `isolation` is shared. Runtime and interaction modes inherit. |
| A3 | `async: false` uses `delegate_task` mode `wait` with `timeoutMs` = the smaller of the agent timeout and 60 minutes. |
| A4 | The takeover restores `PI_DENY_TOOLS` to its original value at session start (pi-subagents reads it only in its factory). |
| A5 | When the sync emits `--no-extensions`, it also loads Pi's built-in MCP and tool-search extensions. Without tool-search, T3's bridge makes all its tools direct. |
| A6 | The sync never adopts an unmarked instance. The rollout slice replaces the spike `pi-scout`. |
| A7 | `/t3-sync-agents` and `/t3-subagents-doctor` are registered whenever the extension loads. No separate CLI. |
| A9 | `session-mode: fork` is a gap: the child starts fresh; the sync output and the launch result say so. |
| A10 | The timeout timer runs per child run. A follow-up run gets a new timer. |
| A11 | After `caller_ping`, the child runtime blocks further tool calls in that run. |
| A12 | Paths and modes come from environment variables with defaults: `PI_T3_SETTINGS_PATH` (default `~/.t3/userdata/settings.json`), `PI_T3_NAMESPACE` (instance id prefix, default `pi-`), `PI_T3_AGENTS_DIR` (default: the global agents folder). Tests and the live namespace use them. |
| A13 | Managed instance `binaryPath` is copied from the main instance; without one, the sync uses `pi` resolved from `PATH`. |
| A14 | The extension path written into managed instances is the absolute path of the extension copy that runs the sync. Production syncs run from the release copy; namespace syncs run from the slice worktree. |
| A15 | Root width limit is 16 (pi-subagents' hard maximum). |

### Modules

Each slice in one wave changes a different module; the entry file only wires modules together.

- **Takeover.** Runs only when `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` are both present (presence only; values are never read). While loading: add `subagent` and `subagent_resume` to `PI_DENY_TOOLS`. At session start: restore the original value; if no foreign `subagent` is registered, register the T3 `subagent`; otherwise register nothing, deactivate pi-subagents' launch tools, and add a compatibility notice to the first run. Always deactivate pi-subagents' `subagent_kill` in T3. ADR 0001.
- **Agent catalog.** Reads agent definitions with the pi-subagents rules: one regex per `key: value` line; `env` and `deny-env` accept a `|` block; `enabled: false` skips the file. Relative paths resolve from the agent configuration folder (the value of `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), not from the agents folder. Detects project agents in the working directory for the D18 error.
- **Instance planner.** Pure function from one agent definition plus host facts to the expected managed instance entry and its revision. The sync, the stale check and the revision header all use it.
- **Settings writer.** The only code that writes T3 settings: own-writer lock, backup, temporary file, final compare, rename, post-reload verification (ADR 0005). Used by the sync and by the live-test setup and teardown.
- **Sync command.** `/t3-sync-agents [--prune] [--yes]`.
- **Roster.** Builds the hidden roster message for the parent model.
- **Launch planner.** Parent side: validation, first messages, launch keys, bridge calls, result states.
- **Live-children ledger.** Parent side, in memory per Pi process: reservations and live tasks, with the transition table below.
- **Spawn policy and guard.** Caller identity, allowlist, visibility, budget, and the `tool_call` guard for raw delegation.
- **Child runtime.** Runs only in a managed instance (identity variable present): environment at load, prompt strip, header and revision check, caller ping, budget-0 tool removal, context warnings, time limit.
- **Doctor.** `/t3-subagents-doctor` and the startup checks. Each module registers its compatibility checks here.

### Managed instance shape

- Id `<namespace><agent>` (production namespace `pi-`). The agent name must match `[A-Za-z0-9_-]` and the id must be at most 64 characters; otherwise the sync skips the agent and reports it.
- `driver: "pi"`, `displayName: "Pi <agent>"` (namespace syncs use a name that shows the namespace), `enabled` from D12.
- `environment` (all `sensitive: false`, none from the agent `env`): `PI_T3_AGENT=<agent>`, `PI_T3_REVISION=<revision>`, and outside the production namespace also `PI_T3_NAMESPACE` and `PI_T3_AGENTS_DIR`.
- `config.binaryPath` (A13), `config.launchArgs`, `config.managedBy = "pi-t3-subagents"`, `config.namespace = "<namespace>"`. The sync owns an entry only when both marker values match its own namespace.
- Revision: a short hash over the planned `launchArgs`, `binaryPath`, `displayName`, `enabled` and the environment without the revision itself.
- Launch arguments: long flags only, absolute paths, quoted when they contain spaces (T3 does no `~` expansion and rejects unknown short flags). The extension's own `--extension` comes first. The sync refuses arguments that T3 reserves (`--mode`, `--session`, `--session-id`, `--no-session`, `--resume`, `--continue`, `--fork`, `--print`, `--export`, `--help`, `--list-models`, `--version`).

### Field mapping

"Launch" = instance launch arguments (sync). "Parent" = launch planner or policy rule. "Child" = child runtime. Every field that pi-subagents parses is listed.

| Field | T3 mapping |
|---|---|
| name | Launch: instance id, display name, `PI_T3_AGENT`. |
| description | Parent: roster entry (D30). Not sent to the child. |
| model | Launch: `--model <ref>` when set. Parent: A1 when absent. |
| thinking | Launch: `--thinking <level>` when set. Parent: A1. |
| allow-model-override | Parent: when false, drop the `model` and `thinking` parameters. |
| allowed-models | Parent: validate the override before launch; the agent's own default is always allowed; the error lists the allowed refs. |
| tools | Launch: absent or `all`: no flag. `none`: `--no-builtin-tools`. List: `--tools <list>` plus `caller_ping`; agents that may spawn also get `subagent`, `mcp__t3-code__delegate_task`, `mcp__t3-code__task_status`, `mcp__t3-code__task_cancel`, `mcp__t3-code__t3_thread_send`. |
| deny-tools | Launch: `--exclude-tools <list>`. Leaves also exclude `subagent` and the thread-starting bridge tools (`delegate_task`, `create_threads`, `t3_thread_launch`, `t3_thread_fork`, `t3_thread_send`, `schedule_task`, each with the `mcp__t3-code__` prefix). |
| extensions | Launch: absent or `all`: no flag (the extension itself is still first). `none` or a list: `--no-extensions`, the extension, Pi's built-in MCP and tool-search (A5), then each entry. `~` is expanded; relative paths resolve from the agent configuration folder; installed `npm:` and `git:` specs become their installed path as in pi-subagents; other specs pass through. |
| skills | Launch: absent or `all`: no flag. `none`: `--no-skills`. List: `--no-skills` plus `--skill <absolute path>` per name. Unknown names skip the agent with a report. `=auto`/`=manual` are removed (gap, D9). |
| inject-skills | Parent: prepend each skill as a `<skill name="...">` block to the first message, in pi-subagents' format. |
| system-prompt | Launch: `replace`: `--system-prompt <agent file>`. `append` with `inherit-append-system: false`: `--append-system-prompt <agent file>`. Child: strip the frontmatter in both cases. `append` with `inherit-append-system: true`: the child appends the body before each run. Absent: Parent puts the body into the first message as a role block. |
| inherit-append-system | Launch: true: no flag. False: `--append-system-prompt ""`, unless the agent file is already passed with that flag. |
| env | Child: set while the extension loads, before later extensions (D24). Variables that Pi reads before extensions load are a gap; the sync reports them. Values never enter settings, plans or backups. |
| mode | Parent: chooses the mode hint. |
| async | Parent: true: mode `async`. False: A3 and D20. |
| auto-exit | Parent: chooses the mode hint. No process exit in T3. |
| timeout | Child: hard stop of the run (A10). |
| timeout-warn-threshold | Child: one wrap-up steer. |
| context-warn-threshold, context-warn-step | Child: wrap-up steers as in pi-subagents. |
| report-context-usage | Gap: T3 owns the wake text. |
| spawning | Parent: allowlist check against the caller (`PI_T3_AGENT`; absent = root, which may launch any agent visible to root). Launch: tool exposure (tools, deny-tools). Absent = false. |
| spawn-depth | Parent and child: exact budget. Child budget = min(child `spawn-depth` or 1, caller budget minus 1); root budget is unlimited. Budget 0: the child removes `subagent` and the thread-starting bridge tools; a launch fails with "Spawn budget is exhausted." |
| spawn-width | Parent: ledger (D11, D21); root limit A15; hard maximum 16. |
| session-mode | `lineage-only`: native. `fork`: gap (A9). |
| trust-project | Launch: `--approve` for interactive agents with `trust-project: true`, otherwise `--no-approve`. |
| no-context-files | Launch: `--no-context-files`. |
| task-expansion | Parent: `shell` expands inline and fenced shell blocks in the task before launch, 30 seconds per command, in the parent's working directory. |
| visible-to | Parent: check against the caller; roster filter. |
| enabled | Sync: D12. Parent: launch error. |
| flags | Launch: appended last. A reserved T3 flag skips the agent with a report. |
| cwd, deny-env, no-session, idle-timeout, on-timeout, parent-close-policy, llm-as-a-verifier fields | Gaps. |

The sync output lists gaps once per agent that uses them; the README lists all gaps.

### Launch flow (parent side)

1. **Validate everything before any bridge call:** parameter rules from pi-subagents (`name` pattern and length, non-empty `title`, `agent` present); agent exists, is enabled and global; not the caller's own agent; `visible-to`; `spawning`; spawn budget; model override rules; task expansion success; instance present and its settings equal to the plan; bridge tool `mcp__t3-code__delegate_task` callable.
2. **Reserve width** for the whole batch synchronously, before the first `await`. If live plus reserved plus new exceeds the width, fail. Parallel tool calls therefore cannot exceed the width.
3. **Build each first message:** header line, injected skills, role block (only when `system-prompt` is absent), mode hint, expanded task, summary instruction (only with the autonomous hint).
4. **Launch keys:** `clientRequestId` = hash of the tool call id, the child index and the canonical request before shell expansion (agent, task text, title, model, thinking). An exact retry gets the original child from T3; any change gets a new key.
5. **Start all children:** call `delegate_task` through `ctx.executeTool` in array order with mode `async` for asynchronous children and mode `wait` for synchronous children; the synchronous calls run concurrently and are awaited together after all asynchronous children started. Update the ledger from each response.
6. **Mid-batch failure:** earlier children keep running; release the reservations of children that did not start; throw an error that names the failed child and lists the started task ids and child thread ids.
7. **Return** the result shape below. Errors throw. No error is reported through `details`.

Header line (first line of each first message): `<!-- pi-t3-subagents:v1 {"budget":<n>,"caller":"<agent or root>","revision":"<expected revision>"} -->`.

Result: `structuredContent = { launches: [ item ] }` for single launches and batches, where an item is `{ name, agent, taskId, childThreadId, providerInstanceId, model, state, wakeExpected, summary, pendingQuestion, pendingApproval }`. `details` never contains a `results` array (T3 would draw a second, native subagent card).

| State | When | Text tells the model |
|---|---|---|
| `running` | Async launch, child not finished. | Completion wakes this thread; end your turn. |
| `finished` | The response already has a final status (async child that finished fast, or a completed wait). | The child's reply (`summary`) and status; no wake will come. |
| `waiting` | A wait ended because the child asks a question or needs an approval. | The child waits for input in its thread; whether a wake follows (verify, U19). |
| `wait_timed_out` | A wait reached its limit. | The child still runs; a wake comes when it finishes. |

Every item text also names: stop with `task_cancel {taskId}`; continue a finished child with `t3_thread_send {threadId: childThreadId, message}`; read with `task_status {taskId}`, which marks the result read and suppresses the wake.

Mode hints in T3:

- Background, or `auto-exit: true`: "Complete your task autonomously." and the summary instruction, as pi-subagents.
- Interactive with `auto-exit: false`: "You run in a T3 Code child thread. The user can open this thread and reply. Ask questions with ask_user when it is available. When the work is done, end your turn with your final report; your caller is woken with it. The user may continue this thread later."

### Live-children ledger

All transitions are idempotent and keyed by task id or reservation id.

| Event | Effect |
|---|---|
| `subagent` call validated | Reserve one slot per child, or fail when the width is full. |
| Launch response with a non-final status | Reservation becomes live task. |
| Launch response with a final status | Release the reservation. |
| Launch error | Release the reservation. |
| Raw input contains a wake for a live task | Remove the task. A wake can carry several tasks, in the full or the short `task_status` form. |
| `task_cancel` result for a live task (any status) | Remove the task. |
| `task_status` or `t3_thread_read` result with a final status for a live task | Remove the task. Observing a call that the model made is not polling. |
| `t3_thread_send` call to a known child thread | Reserve one slot, or block the call when the width is full. |
| `t3_thread_send` result with a new task id | Reservation becomes live task. |
| `t3_thread_send` result without a task id, or an error | Release the reservation. |
| Raw input that looks like a wake but cannot be read | Stop width enforcement for this session and add a notice (D32). |

Known drift: a wake that never arrives (for example after a Pi process restart, or a user stop if U9 shows no wake) leaves a task live until the process restarts.

### Spawn policy and raw-delegation guard

- Caller identity: `PI_T3_AGENT` (absent = root). Allowlist, `visible-to` and the self-launch guard as in pi-subagents.
- Budget: from the header (child), or the agent's own `spawn-depth` when the first message has no header, or 0 when the header cannot be read.
- Guard: a `tool_call` handler. In a child thread, a `mcp__t3-code__delegate_task` call is allowed only when its `parentToolCallId` is an in-flight call of the wrapper's own `subagent` tool; calls from codemode scripts or from the model are refused. In a root thread, a raw call whose target is a managed instance is refused; other targets pass. In leaves and at budget 0, every thread-starting bridge tool is refused (the launch arguments also exclude them). If Pi stops providing `parentToolCallId`, the guard refuses (fails closed) and the doctor reports it.
- This is a tool policy, not a security sandbox: a child that can edit files can change its own agent definition.

### Child runtime

- **Environment:** while loading (the extension loads first), read the agent file named by `PI_T3_AGENT` and set its `env` entries in the process environment. Skip keys reserved for this extension and pi-subagents spawn keys.
- **Prompt:** before each run, remove a leading frontmatter block from the prompt section that holds the agent file text. Never change other sections.
- **Header and revision:** on the first user input, read and remove the header line, and store budget, caller and expected revision in the session. If the expected revision differs from `PI_T3_REVISION`, replace the input with an instruction to reply only: `T3-SUBAGENTS STALE INSTANCE <id>: expected revision <a>, running <b>. Run /t3-sync-agents, wait a few seconds, and launch again.` (one small model call; no other work).
- **Caller ping:** tool `caller_ping { message }`. Result: end the turn now; the final reply must start with the line `CALLER PING` followed by the message; the caller is woken with it and continues this thread. Further tool calls in that run are blocked (A11).
- **Context warnings:** same thresholds, steps and intent as pi-subagents.
- **Time limit:** one wrap-up steer at `timeout-warn-threshold`; the run is aborted at `timeout`.

### Sync flow and settings writer (ADR 0005)

1. Read the agent definitions and the T3 settings.
2. Plan per agent: add, update, unchanged, disable, prune (only with `--prune`), conflict (id exists without matching markers), skip (with reason). Collect gap notes. Warn when the main instance lacks the extension argument.
3. Show the plan. No environment values appear in it. No changes: report "up to date"; no write, no backup.
4. Confirm through the UI; without a UI require `--yes`.
5. Take the own-writer lock: a lock file next to the settings file (`.settings.json.pi-t3-subagents.lock`), created exclusively (mode 0600), that holds `<pid> <host> <random id>`. Every Pi profile that targets one settings file shares it. It serializes this extension's writers (sync, live-test setup and teardown); it does not lock T3. The sync never removes a lock on its own (owner decision 2026-10-26, after the S2 reviews). A lock whose holder process is alive on this host is busy: the sync waits at most a few seconds, then stops with an error that names the holder pid; `--break-lock` never removes it. Any other lock (holder process gone, another host, unreadable or malformed content) stops the sync at once with the lock path, holder pid and host, and age, and tells the user to run `/t3-sync-agents --break-lock`. `--break-lock` removes that lock once, only when its content (or, for an unreadable lock, its file identity) is unchanged since it was read and shown; otherwise it refuses. Then the normal locked sync runs. A release removes only the writer's own lock, and a writer whose token is no longer in the lock file does not commit.
6. Save the backup (folder mode 0700, file mode 0600); keep the newest 10.
7. Write the new content to a temporary file in the settings folder (mode 0600). Change only the planned `providerInstances` entries; keep all other content.
8. Read the settings file again and compare it with the content from step 1. If it changed, delete the temporary file, release the lock, and stop: "settings changed, run the sync again". Otherwise rename the temporary file over `settings.json` at once.
9. Release the lock. Wait for T3 to reload (debounce 100 ms; wait up to 3 seconds), read the file again, and check that every planned entry is present. If not, report "lost to a concurrent T3 settings save; run the sync again".
10. Report counts, skipped agents, conflicts, gap notes and the main instance warning.

Remaining risk, stated in the README: a T3 settings save that falls between steps 8 and 9 can be lost, or can erase the sync (the second case is detected in step 9). T3 locks its own writes only inside its own process, and T3 offers no settings route that this extension can use.

### Compatibility contracts (D31)

| Id | External behavior relied on | Check | When it breaks |
|---|---|---|---|
| C1 | pi-subagents reads `PI_DENY_TOOLS` in its factory and then skips `subagent` and `subagent_resume` | Session start: no foreign `subagent` | Fail soft: no delegation, notice (D29) |
| C2 | Pi loads command-line extensions before settings packages; a duplicate tool name at load is fatal | Real-Pi probe in S1 | Covered by C1 at runtime; README warns against a second install path |
| C3 | Bridge tool names `mcp__t3-code__delegate_task`, `task_status`, `task_cancel`, `t3_thread_send` and their exposure | Launch and doctor: tool present and callable | Launch error naming the missing tool |
| C4 | `delegate_task` input, the `"default"` model, options, `clientRequestId` replay, result at `structuredContent.structuredContent` | Doctor reports the last launch outcome | Launch error with the raw result text |
| C5 | Wake text format | Ledger parse | Fail open with notice (D32) |
| C6 | T3 settings shape: `providerInstances`, `config` keeps unknown keys, `environment` entries | Sync and doctor | Sync refuses to write and names the unexpected shape |
| C7 | `launchArgs` tokenizer and reserved flags | Sync validation; doctor shows instance availability | Agent skipped, or instance unavailable in T3 |
| C8 | Pi extension API: `before_agent_start` prompt sections, `input` transform, `tool_call` `parentToolCallId`, `setActiveTools`, `registerTool` at session start | Doctor | Feature disabled with notice; the guard fails closed |
| C9 | pi-subagents frontmatter rules (copied in the agent catalog) | None automatic | Documented; re-check after pi-subagents updates |
| C10 | T3 reloads changed instances asynchronously | Child revision check | Stale reply (D28) |

### T3 facts the design uses

- Direct bridge tools: `orchestrator_capabilities`, `delegate_task`, `task_status`; the others are deferred only while Pi's built-in tool-search is present, otherwise direct.
- Wake: `Delegated task <taskId> (<title>) [<status>]:` plus the child's last reply, or a short form that points to `task_status` once the 16,000-byte inline budget per wake is used.
- `mode: "wait"` ends on a final status, a child question, a child approval, or its time limit; a completed wait delivers the result and no later wake.
- Reading a final result with `task_status` or `t3_thread_read` marks it read and suppresses the wake. An async launch whose child already finished is marked read at once.
- `t3_thread_send` to a finished child starts a new task with a new id; its end wakes the sender.
- `clientRequestId`: T3 replays the stored launch for a known key without comparing the payload.
- Children inherit the parent's runtime mode and cannot exceed it.
- Instance `config` keeps unknown keys; ids match `^[a-zA-Z][a-zA-Z0-9_-]*$`, at most 64 characters.

Re-check these after a T3 update; the installed app bundle is the authority.

### Release pin (applied 2026-10-26)

- Release copy: a detached checkout of this repository at `~/.pi/agent/t3-subagents/release`, at 18a907e.
- The main instance `pi` loads `--extension ~/.pi/agent/t3-subagents/release/index.ts` (absolute path). The spike `pi-scout` uses the release copy's `index.ts` and `prompts/scout.md`. Nothing else changed.
- Backups: `~/.pi/agent/t3-subagents/backups/settings-20261026T104940Z.json` (before the main instance change), `settings-20261026T111904Z.json` (before the `pi-scout` change).
- Landed slices do not reach the owner's T3 until the rollout slice moves the release copy to the new tip. Slices may therefore remove `prompts/scout.md` from the repository.

## Testing Decisions

Good tests check behavior that Pi, T3 or the user can observe: tools registered and active, arguments sent to the bridge, first message text, thrown errors, settings file content, backups and their modes. They do not check internal function structure. Expected values come from this spec, from pi-subagents behavior in the field map, and from the T3 facts; never from the output of the code under test.

Layers:

1. **Main seam: fake Pi host plus fake T3 bridge.** Load the extension factory against a fake extension API that records tools, commands, event handlers and active tools, and can fire events (including parallel tool calls and nested calls with `parentToolCallId`). `ctx.executeTool` calls to bridge tools go to a fake bridge that records arguments and returns T3-shaped results, final or not, or errors. The sync runs against a temporary home, a temporary settings file and a fake concurrent writer. Run with Bun's test runner through `heavy`; S1 adds the setup.
2. **Real Pi probes.** `pi --mode rpc --no-session` with a probe extension that logs active tools and their source, fake T3 variables set and `PI_DENY_TOOLS` unset in the probe environment. Prior art: `probe.ts` in the spike artifacts.
3. **Live T3 Nightly e2e** in the scratch project `~/Dev/scratch/t3-subagents-e2e` (a throwaway git repository; S2 adds it to T3 once).

Live e2e rules (D5, D6, D25):

- **Namespace:** each slice uses `t3e2e-<slice>-` (for example `t3e2e-s3-`). A worker may create, change and delete only instances whose id starts with its own namespace, and only through the settings writer. Other instances, including the owner's, are read-only.
- **Setup:** the live-test setup creates the test main instance `t3e2e-<slice>-main`, which loads the slice worktree's extension and sets `PI_T3_NAMESPACE` and `PI_T3_AGENTS_DIR` (the repository's fixture agents). A sync run from a thread on it writes the namespace's managed instances.
- **Fixture agents:** repository fixtures with the frontmatter shapes of the owner's agents (leaf, spawning, interactive, synchronous, with an extension list, with `env`) and a low-cost model available on the host (for example `cpa/claude-haiku-5-5`). Live tests never launch the owner's real agents.
- **Driving runs:** `~/.t3/bin/t3 thread start <project> <message> --provider t3e2e-<slice>-main --model default --wait --json`, `t3 thread send` and `t3 thread show --json` (the `t3` launcher is not on `PATH`). Use the browser (`agent-browser-chrome`) only for UI checks: lineage display, question cards, composer command list, UI settings edits.
- **Pairing (UI checks only):** `~/.t3/bin/t3 auth pairing create` with a 15-minute time limit. Keep the token in a temporary file, never in reports or logs. After the run, revoke the browser session with `t3 auth session revoke`, confirm with `t3 auth session list`, and delete the token file.
- **Teardown:** delete every instance of the namespace and confirm that none remains. A slice is not complete with namespace instances left behind.
- **Receipt:** each live report records the extension path and commit under test, the namespace, the instance ids created and deleted, and the evidence (thread text, session file extracts, screenshots) under `~/.pi/artifacts/worker/<slice>/`.
- Do not restart the T3 server. Do not change T3 settings outside the namespace, except in the rollout slice.

Unverified facts, each closed by a slice acceptance check:

| Id | Fact to verify | Slice |
|---|---|---|
| U1 | Two approvals per launch in `approval-required` mode. | S9 |
| U2 | Named `mcp__t3-code__*` entries in `--tools` keep those bridge tools active in a child. | S5 |
| U3 | A parent on a main instance can call the deferred `task_cancel` and `t3_thread_send`. | S6 |
| U4 | `config.managedBy` and `config.namespace` survive a T3 UI settings edit. | S2 |
| U5 | With `--no-extensions` plus built-in MCP and tool-search, a child does not get the whole bridge catalog as active tools. | S3 |
| U6 | Frontmatter removal before the run reaches the model request. | S3 |
| U7 | The raw input event can remove the header from the first prompt that T3 sends. | S3 |
| U8 | The parent's raw input event sees wakes, including steered and batched wakes. | S4 |
| U9 | Whether a user stop in a child thread wakes the parent. | S4 |
| U11 | `/t3-sync-agents` appears in the T3 composer, and a slash command sent through `t3 thread start` runs. | S2 |
| U12 | Failed suppression does not stop Pi: no duplicate, session usable, notice present. | S1 |
| U13 | Environment set while the extension loads reaches later extensions and bash tools. | S3 |
| U14 | The guard refuses raw `delegate_task` from a leaf, from a spawning child, and from codemode. | S5 |
| U15 | Two concurrent `wait` launches from one tool call run in parallel in T3. | S4 |
| U16 | The `t3 thread` CLI drives parent turns on a test main instance. | S2 |
| U17 | A launch right after a sync runs the new revision or returns the stale reply; never the old configuration silently. | S3 |
| U18 | How T3 shows the takeover notice (model-visible text in the first run). | S3 |
| U19 | Whether a wake follows a `wait` that ended early because of a question or approval. | S4 |

(U10 was closed by the review: pi-subagents does not inject its roster when its `subagent` is denied. D30 replaces it.)

## Delivery Slices

One worker per slice in its own worktree (`wt new <issue>-<slug> <repo>`), landed with `wt land`. Slices in one wave change different modules; when two land close together, the later one rebases the entry file. Every slice ends with its affected tests through `heavy`, its probes, its live checks under the rules above, and its doctor checks.

Waves: S1 and S2 (no blockers) -> S3 -> S4, S5, S6, S7 and S8 in parallel -> S9 -> S10.

### S1: Takeover fails soft, test harness, doctor

Blocked by: none.

Delivers: the test harness (layers 1 and 2), the takeover with registration at session start and the fail-soft path, the `PI_DENY_TOOLS` restore, pi-subagents' kill and resume hidden in T3, and `/t3-subagents-doctor` with checks C1, C2 and C3.

- [ ] Layer 1: outside T3 the extension registers no tool and changes no environment; the doctor reports "not inside T3".
- [ ] Layer 1: inside T3 without a foreign `subagent`, the T3 `subagent` exists after session start, `PI_DENY_TOOLS` equals its original value, and `subagent_kill` is inactive.
- [ ] Layer 1: inside T3 with a foreign `subagent`, the extension registers nothing, deactivates pi-subagents' launch tools, and adds the notice to the first run.
- [ ] Layer 2 positive probe with the real pi-subagents: exit 0; `subagent` comes from this extension; `subagent_resume` is absent; `subagent_kill` is inactive; a bash call sees the original `PI_DENY_TOOLS`.
- [ ] Layer 2 negative probe where suppression fails (for example a fixture extension that registers `subagent` and ignores the variable): Pi starts, no duplicate-tool error, the session works, the notice is present (U12).
- [ ] Layer 2 outside T3: pi-subagents' three tools are unchanged.

### S2: Sync, settings writer and live-test namespace

Blocked by: none.

Delivers: the agent catalog, the instance planner with revisions, the settings writer (ADR 0005), `/t3-sync-agents [--prune] [--yes]` with namespaces, the live-test setup and teardown, the fixture agents, the scratch project in T3, and doctor checks C6 and C7.

- [ ] Layer 1: for fixture agents covering every "Launch" row of the field mapping, the planned entries equal the expected entries written from this spec, including a relative extension path resolved from the agent configuration folder and `PI_CODING_AGENT_DIR`.
- [ ] Layer 1: a dummy secret in an agent `env` appears in no settings output, plan text or backup; pre-extension Pi variables are reported as gaps.
- [ ] Layer 1: a second sync reports "up to date" and changes no file; removed and disabled agents become `enabled: false`; `--prune` deletes only disabled managed instances of the same namespace.
- [ ] Layer 1: a production sync never changes a `t3e2e-` entry and a namespace sync never changes an entry of another namespace; an unmarked entry with a planned id is a conflict; the main instance is never changed and its missing extension argument gives a warning.
- [ ] Layer 1: invalid names, unknown skills and reserved flags skip the agent with a reason; launch arguments contain only long flags and absolute paths.
- [ ] Layer 1 writer interleavings with a fake concurrent writer: a change before the final compare stops the sync; a write that erases the managed entries after the rename is reported by the verification; two of this extension's writers serialize on the lock; backups have mode 0600 in a 0700 folder and 10 remain; no UI and no `--yes` means no write.
- [ ] Layer 2: the planned launch arguments for each of the owner's 10 agent definitions (read-only; no settings write) start Pi with fake T3 variables without an error.
- [ ] Live (`t3e2e-s2-`): setup creates the test main instance; a sync sent through `t3 thread start` creates the fixture instances (U16, U11); T3 lists them as available; the command appears in the composer (browser, U11); after a UI edit of a namespace instance's display name the markers of the other namespace instances survive (U4); teardown leaves no `t3e2e-s2-` instance.

### S3: Single launch and child bootstrap

Blocked by: S1, S2.

Delivers: the launch planner for single launches (validation, first message, A1, launch keys, header, result states), the stale check, the roster, the mode hints, and the child runtime bootstrap (environment at load, prompt strip, header and revision check). Doctor check C4 and C8. Removes the spike prompt copy from the repository.

- [ ] Layer 1: each validation error in "Launch flow" step 1 throws before any bridge call, with a message that names the cause.
- [ ] Layer 1: bridge arguments follow A1 and A2 for: no override, model override inside the allowed models, thinking-only override, override with `allow-model-override: false`, agent without a model.
- [ ] Layer 1: launch keys: same tool call id, index and request give the same key; a changed task, title, agent, model or thinking gives a new key; a changed shell-expansion output alone does not.
- [ ] Layer 1: result states `running` and `finished` (fake bridge returns a final status in the launch response): `finished` carries the summary inline and `wakeExpected: false`; no `details.results`.
- [ ] Layer 1: first messages match the expected text for: header, injected skills, absent `system-prompt`, background hint, interactive hint, shell expansion.
- [ ] Layer 1: the roster lists only enabled global agents that the caller may launch, with T3 lifecycle wording, and is sent again only when it changes.
- [ ] Layer 1 child: a header is removed and stored; a missing header gives the agent's own depth; an unreadable header gives budget 0; a revision mismatch replaces the input with the stale instruction.
- [ ] Layer 2: a child's prompt starts with the agent body and has no frontmatter (U6); an `env` value from the agent file is visible to a later extension and to bash (U13); the header is not in the stored user message (U7); an agent with an extension list does not get the whole bridge catalog active (U5).
- [ ] Live (`t3e2e-s3-`): the parent launches a leaf fixture with a model override and a fixture with shell expansion; both child threads show lineage (one browser screenshot) and the expected model; both wakes arrive. Record how the takeover notice appears (U18) by loading a namespace main instance with a forced suppression failure.
- [ ] Live: after a fixture change without a sync, the launch is refused with the sync message; after a sync followed at once by a launch, the child runs the new revision or returns the stale reply (U17).

### S4: Synchronous launches, batches and width ledger

Blocked by: S3.

Delivers: `children[]` batches, synchronous launches with the four result states, and the live-children ledger with every transition in its table. Doctor check C5.

- [ ] Layer 1: one invalid child means no bridge call; a batch larger than the free width fails before launch; two parallel `subagent` calls with width 1 start one child and refuse the other.
- [ ] Layer 1: when the fake bridge fails the second of three children, the first stays started, the third is never sent, the error lists the first child's ids, and the unused reservations are released.
- [ ] Layer 1: each ledger transition in the table, including `t3_thread_send` reservation and blocking, wakes with several tasks and the short form, and the fail-open path on an unreadable wake.
- [ ] Layer 1: a batch with two synchronous children and one asynchronous child starts all three before awaiting; the synchronous results arrive as `finished`, `waiting` or `wait_timed_out` items with the right text.
- [ ] Live (`t3e2e-s4-`): a batch of two leaf fixtures gives two wakes and an empty ledger (U8); a synchronous fixture returns its reply inline and no later wake arrives; two synchronous fixtures in one batch run at the same time (U15); a synchronous fixture that asks a question returns `waiting`, and the run records whether a wake follows (U19); record whether a user stop in a child thread wakes the parent (U9).

### S5: Nested launches, exact depth and raw-delegation guard

Blocked by: S3.

Delivers: caller identity, allowlist, visibility, self-launch guard, the exact budget, tool exposure for spawners and leaves, and the raw-delegation guard (D22).

- [ ] Layer 1: the header budget is min(child depth, caller budget minus 1); budget 0 removes `subagent` and the thread-starting bridge tools in the child.
- [ ] Layer 1: the caller's `spawning` list, the target's `visible-to` and the self-launch guard each refuse with a clear error.
- [ ] Layer 1 guard: in a child, raw `delegate_task` from the model and from a codemode script is refused, and the wrapper's own nested call passes; in root, a raw call to a managed instance is refused and a call to a non-managed instance passes; without `parentToolCallId` the guard refuses.
- [ ] Layer 2: an instance with a fixed tool list that may spawn has `subagent` and the named bridge tools active (U2); a leaf has neither.
- [ ] Live (`t3e2e-s5-`): a spawning fixture child launches a leaf grandchild; the grandchild's wake reaches the child thread and the child's wake reaches root; a spawning fixture launched with budget 1 cannot launch; raw `delegate_task` attempts from a leaf, a spawning child and codemode are refused (U14).

### S6: Caller ping and lifecycle guidance

Blocked by: S3.

Delivers: the `caller_ping` tool in managed children, and live proof of the T3 lifecycle tools named in the launch result.

- [ ] Layer 1: `caller_ping` exists only in managed children; after a ping, other tool calls in that run are refused with the ping reason.
- [ ] Live (`t3e2e-s6-`): a child that calls `caller_ping` ends its run; the wake reply starts with `CALLER PING`; the parent continues the child with `t3_thread_send` and receives the final wake.
- [ ] Live: the parent stops a running child with `task_cancel` (U3) and the child stops.

### S7: Context warnings and time limit

Blocked by: S3.

Delivers: `context-warn-threshold`, `context-warn-step`, `timeout-warn-threshold` and `timeout` in the child runtime, per run.

- [ ] Layer 1: with a fake clock and fake context usage, the steers and the abort happen at the expected points, once per step; a follow-up run starts a new timer.
- [ ] Live (`t3e2e-s7-`): a fixture with a very short limit gets the warning steer, its run stops at the limit, and the parent wake shows the final status; the report records that status for the README.

### S8: Interactive agents

Blocked by: S3.

Delivers: interactive fixtures with `auto-exit: false` run as child threads that the user steers, with `ask_user` as T3 question cards.

- [ ] Layer 1: the interactive hint is used only for `mode: interactive` with `auto-exit: false`.
- [ ] Live (`t3e2e-s8-`, browser): an interactive fixture with pi-ask in its extension list asks one `ask_user` question; the card appears in the child thread; the answer reaches the child; the child's final reply wakes the parent; a follow-up typed in the finished child thread wakes the parent again.

### S9: README, supervised-mode check, doctor completeness

Blocked by: S4, S5, S6, S7, S8.

Delivers: a README for any pi-subagents user (purpose, setup on a main instance, sync, field mapping with gaps, lifecycle with T3 tools, caller ping, supervised behavior, the settings-write risk, compatibility contracts and the doctor, update advice), an updated header comment in the entry file, and a doctor that covers C1 to C10.

- [ ] Live (`t3e2e-s9-`): in `approval-required` mode one launch shows the approvals that the README describes, and the child inherits the mode (U1).
- [ ] Live: a worker follows the README from a fresh namespace main instance without the extension and gets a working leaf launch.
- [ ] The doctor output lists C1 to C10 with pass or fail; the README lists every gap and links the ADRs.

### S10: Rollout to the owner's setup

Blocked by: S9.

Delivers: the authorized switch of the owner's real setup (D27). Exact steps:

1. Move the release copy to the landed tip (detached checkout); the main instance path stays the same.
2. Delete the spike `pi-scout` through the settings writer (backup first).
3. From a thread on the main instance, run `/t3-sync-agents` in the production namespace for the owner's agents.
4. Launch `scout` from a main-instance thread in the scratch project and confirm the wake.
5. Run `/t3-subagents-doctor`.

- [ ] All managed instances of the owner's enabled agents exist and are available; no unmarked `pi-` instance remains from the spike.
- [ ] The scout launch works and the doctor reports no broken contract.
- [ ] The report names every backup path for rollback.

## Out of Scope

- Changes to T3 Code, Pi or pi-subagents, and any edit of their install files.
- Project agents and per-project instances (D18, deferred).
- Skill annotations `=auto` and `=manual` (D9).
- The gaps in the field mapping table.
- A guarantee against a concurrent T3 settings save (D19).
- A separate command-line sync tool (A7).
- Bypassing the T3 bridge to save one approval (D16).

## Further Notes

Risks:

- **Takeover depends on pi-subagents internals** (C1, ADR 0001). After a pi-subagents update it fails soft; run the doctor.
- **Settings race** (D19, ADR 0005): small, documented, partly detected.
- **Load and cost:** T3 runs model and command discovery per managed instance and project. Discovery loads the extension without T3 variables; it must stay quiet there.
- **Ledger drift** (see the ledger table).
- **Wake size:** at most 16,000 bytes of child replies inline per wake. Long reports belong in files.
- **Supervised children:** in async mode the parent gets no signal when a child waits for an approval in its own thread.
- **T3 Nightly changes:** the T3 facts come from one nightly build; run the doctor after updates.

Rollback: restore the newest backup from `~/.pi/agent/t3-subagents/backups/` over `~/.t3/userdata/settings.json`.

OPEN: none. Deferred: project agents (D18), skill annotations (D9). Unverified facts U1 to U19 (without U10) are acceptance checks in the named slices.
