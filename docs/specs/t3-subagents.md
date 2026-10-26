# Spec: pi-t3-subagents (full wrapper)

Status: approved by the owner on 2026-10-26 (architect grilling session). Repository: local only, no GitHub repository. Delivery slices are listed in this file instead of GitHub issues.

Vocabulary: see `GLOSSARY.md`. Decisions with lasting effect: `docs/adr/0001` to `0004`.

Baseline: commit ceb7a5d (spike wrapper, round 2). Versions observed: Pi 1.4.0, T3 Code Nightly 0.1.3-nightly.20261026.3710, pi-subagents cf6dbf4.

Evidence used:

- Spike report: `~/.pi/artifacts/worker/t3-subagents-spike/report.md`
- pi-subagents field map: `~/.pi/artifacts/scout/t3-subagents-spec/pi-subagents-map.md`
- T3 Code facts: `~/.pi/artifacts/scout/t3-subagents-spec/t3-facts.md`

## Problem Statement

The owner runs Pi agents through pi-subagents. In a terminal, pi-subagents launches each agent as a hidden process or a terminal pane. Inside T3 Code, those children are invisible to T3: they have no thread, no lineage, and they do not use T3's completion wake.

T3 Code has its own delegation: a Pi thread can call `delegate_task` to start a child thread on a provider instance, and T3 wakes the parent when the child finishes. The spike proved this for one agent (scout) with a hand-written instance.

The owner wants every pi-subagents agent to work inside T3 Code as a T3 child thread, from the same agent definitions, with the same rules. It must work for any pi-subagents user, not only for the owner's ten agents. Neither T3 Code nor pi-subagents can be changed.

## Solution

The pi-t3-subagents extension has three parts.

1. **Takeover.** In every T3 Pi session the extension replaces pi-subagents' `subagent` tool with a T3 version. The T3 version applies the pi-subagents launch rules and starts each agent as a T3 child thread through T3's own bridge tool `delegate_task`. Outside T3 Code, the extension does nothing to tools, so terminal Pi keeps pi-subagents unchanged.
2. **Sync.** The `/t3-sync-agents` command turns each enabled global agent into a managed instance `pi-<agent>` in T3's settings. The agent's static fields become launch arguments and environment entries. The command shows the plan, asks for confirmation, keeps a backup, and writes atomically.
3. **Child runtime.** In a child thread, the same extension makes the agent definition behave as in pi-subagents: it removes frontmatter from the prompt, reads the spawn budget, offers the caller ping, and enforces context warnings and the time limit.

Stopping, continuing and reading children use T3's native tools (`task_cancel`, `t3_thread_send`, `task_status`). Fields that have no T3 meaning are documented gaps.

## User Stories

### Launch

1. As a T3 user, I want my parent thread to launch any enabled global agent with `subagent`, so that I use the same agents in T3 as in the terminal.
2. As a T3 user, I want each launched agent to run in its own T3 child thread with "Subagent of" lineage, so that I can open, read and steer it.
3. As a T3 user, I want the parent thread to wake when a child finishes, with the child's final reply, so that the parent continues without polling.
4. As a parent agent, I want a launch to return the task id, child thread id, instance and status at once, so that I can end my turn and refer to the child later.
5. As a parent agent, I want a launch to fail with a clear error when the agent does not exist, is disabled, is a project agent, or is not visible to me, so that I do not wait for a child that never starts.
6. As a parent agent, I want to pass a model or thinking override that the agent allows, so that I can pick a cheaper or stronger model per task.
7. As a parent agent, I want an override outside the agent's allowed models to fail before launch, so that agent policy holds.
8. As a parent agent, I want an override to be ignored when the agent forbids overrides, so that behavior matches pi-subagents.
9. As a parent agent, I want an agent without its own model or thinking to inherit mine, so that behavior matches pi-subagents.
10. As a parent agent, I want an agent with `async: false` to block until the child finishes, so that synchronous agents keep their contract.
11. As a parent agent, I want the child's first message built as in pi-subagents (injected skills, role block, mode hint, expanded task, summary instruction), so that agents behave the same in T3.
12. As a parent agent, I want shell blocks in the task expanded before launch for agents with shell task expansion, so that worker briefs keep working.
13. As a parent agent, I want a launch to refuse a stale instance and tell me to run `/t3-sync-agents`, so that no child runs with an outdated model, tool list or extension list.
14. As a T3 user, I want pi-subagents' agent roster to stay visible to the parent model, so that the model knows which agents exist.
15. As a T3 user, I want the launch tool to have one result shape for single launches and batches, so that scripts can read it the same way.
16. As a T3 user, I want the launch tool not to produce a second native subagent card in the T3 UI, so that each child appears once.

### Batches and limits

17. As a parent agent, I want to launch several children in one `children[]` call, so that I can fan out work.
18. As a parent agent, I want the whole batch validated before any child starts, so that a bad entry does not leave half a batch running.
19. As a parent agent, I want to know which children already started when a later child fails to launch, so that I can manage the running ones.
20. As an agent author, I want `spawn-width` to cap the number of my live children, so that one agent cannot flood the host.
21. As an agent author, I want `spawning` to limit which agents my agent may launch, so that leaf agents stay leaves.
22. As an agent author, I want `spawn-depth` to narrow along the chain exactly as in pi-subagents, so that spawn cycles stop.
23. As an agent author, I want `visible-to` to hide an agent from callers that are not allowed to launch it, so that private helpers stay private.
24. As an agent author, I want an agent that may spawn to keep the T3 delegation tools even with a fixed tool list, so that nested launches work.
25. As an agent author, I want an agent that may not spawn to have no `subagent` tool, so that the model does not try.

### Lifecycle

26. As a parent agent, I want the launch result to tell me how to stop, continue and read a child with T3's tools and the right ids, so that I do not call pi-subagents tools that cannot work in T3.
27. As a parent agent, I want to stop a running child with `task_cancel`, so that I can abandon wrong work.
28. As a parent agent, I want to continue a finished child with `t3_thread_send`, so that the child keeps its context, and I want to be woken again when it finishes.
29. As a parent agent, I want to be warned that `task_status` on a finished task suppresses the wake, so that I do not lose results.
30. As a child agent, I want a `caller_ping` tool that sends my request to the caller, so that I can ask for a decision and continue in the same thread.
31. As a parent agent, I want a caller ping to arrive as a wake that I can recognize, so that I can relay the decision and continue the child.
32. As a T3 user, I want pi-subagents' `subagent_kill` and `subagent_resume` hidden in T3 sessions, so that the model does not call tools that cannot work there.

### Child runtime

33. As an agent author, I want my agent body to be the child's prompt without the frontmatter, so that the child sees what pi-subagents would give it.
34. As an agent author, I want body edits to apply to the next child without a sync, so that prompt work is fast.
35. As an agent author, I want `context-warn-threshold` and `context-warn-step` to make the child wrap up before compaction, so that work is not lost.
36. As an agent author, I want `timeout-warn-threshold` to warn the child and `timeout` to stop its run, so that a stuck child does not run forever.
37. As an agent author, I want an interactive agent (architect, design) to run in a child thread where I can answer its questions, so that grilling works in T3.
38. As a T3 user, I want `ask_user` questions from a child to appear as T3 question cards in the child thread, so that I answer them in the T3 UI.

### Sync

39. As a T3 user, I want `/t3-sync-agents` to create a managed instance for each enabled global agent, so that I do not edit T3 settings by hand.
40. As a T3 user, I want the sync to show the planned adds, updates, disables and conflicts and ask before it writes, so that I stay in control of T3 settings.
41. As a T3 user, I want a sync with no changes to say "up to date" and write nothing, so that repeated syncs are safe.
42. As a T3 user, I want a timestamped backup before each changing write, with the last 10 kept, so that I can undo a bad sync.
43. As a T3 user, I want the sync to write settings atomically and to stop when the file changed after it planned, so that T3 never reads a half-written file and my UI edits are not lost.
44. As a T3 user, I want a removed or disabled agent's instance to become disabled, so that old child threads stay readable.
45. As a T3 user, I want `/t3-sync-agents --prune` to delete disabled managed instances, so that I can clean up on purpose.
46. As a T3 user, I want the sync never to change an instance it did not create, and to report a name conflict instead, so that my own instances are safe.
47. As a T3 user, I want the sync to warn when my main instance does not load the extension, so that I know why takeover is missing.
48. As a T3 user, I want the sync to report agents it skipped and why (invalid name, unknown skill, reserved launch flag), so that I can fix the agent file.
49. As a T3 user, I want to run the sync from a T3 Pi thread or from a terminal Pi session that loads the extension, so that I can sync where I work.
50. As a pi-subagents user who is not the owner, I want a README that tells me how to install the extension and sync my agents, so that the wrapper works for my agents too.

### Safety and modes

51. As a T3 user in a supervised mode, I want to know that one launch asks for approval twice, so that the second prompt does not surprise me.
52. As a T3 user, I want children to inherit my thread's runtime mode, so that a child never has more rights than its parent.
53. As a T3 user, I want the extension never to read the MCP bearer token, so that credentials stay inside T3's bridge.
54. As a terminal Pi user, I want the extension to change nothing outside T3, so that pi-subagents keeps working as before.
55. As a T3 user, I want processes started from a T3 Pi session not to inherit the takeover's tool denial, so that a `pi` started from bash behaves normally.

## Implementation Decisions

### Owner decisions (rounds 1 and 2)

| Id | Decision |
|---|---|
| D1 | All enabled global agents get a managed instance. The wrapper is universal: any pi-subagents agent definition must work, not only the owner's. |
| D3 | The sync never edits the main instance. It warns when the main instance lacks the extension's launch argument. |
| D4 | Enforce `spawning`, `spawn-width` and `spawn-depth` as pi-subagents does. |
| D5 | Workers may run live T3 Nightly e2e checks without asking, under the hygiene rules in "Testing Decisions". |
| D6 | Live e2e runs use a dedicated scratch project, never a real project. |
| D7 | Stop, continue and status use T3 native tools. pi-subagents' kill and resume tools are hidden in T3 (ADR 0003). |
| D8 | Caller ping is an end-turn ping (ADR 0003). |
| D9 | Child runtime v1: context warnings, timeout warning and hard stop. Skill annotations `=auto` and `=manual` are a gap. |
| D10 | Spawn depth is exact: the remaining budget travels in a task header that the child strips (ADR 0004). |
| D11 | Width counts live children from events: launches minus observed wakes and observed `task_cancel` results. Never poll `task_status` for this. |
| D12 | Removed or disabled agents: instance `enabled: false`. `--prune` deletes disabled managed instances. |
| D13 | A stale instance blocks the launch with "run /t3-sync-agents". |
| D14 | `--system-prompt` points at the agent file; the child strips the frontmatter (ADR 0002). |
| D15 | Sync confirms a diff, writes atomically, and keeps timestamped backups in `~/.pi/agent/t3-subagents/backups/` (last 10). This folder holds only backups. |
| D16 | Supervised modes: accept two approvals per launch; document it. |
| D17 | Interactive agents run as delegated child threads. Each finished run wakes the parent. |
| D18 | Global agents only in v1. Project agents get a clear error. Per-project instances are a deferred follow-up. |
| Seams | One main test seam (fake Pi host plus fake T3 bridge), real Pi probes, live T3 e2e. |

(D2 was the generated-files folder; D14 and D15 replaced it.)

### Assumptions decided by the architect (routine, reversible)

| Id | Assumption |
|---|---|
| A1 | Effective model and thinking follow pi-subagents: override, else agent value, else the parent's value. If the effective pair equals the pair baked into the instance, the launch passes `model: "default"` and empty options. Otherwise it passes the concrete `provider/id` slug, plus `options.thinking` when the model supports thinking. |
| A2 | `delegate_task` gets no `role` (the agent body defines the role; a role only adds a prompt prefix). `clientRequestId` is derived from the tool call id and the child index, so a retried call does not launch twice. `isolation` is shared. Runtime and interaction modes inherit. |
| A3 | `async: false` uses `delegate_task` mode `wait` with `timeoutMs` = the smaller of the agent timeout and 60 minutes. |
| A4 | The takeover restores `PI_DENY_TOOLS` to its original value at session start (pi-subagents reads it only in its factory). |
| A5 | When the sync emits `--no-extensions`, it also loads Pi's built-in MCP and tool-search extensions, so the T3 bridge keeps its deferred tool exposure. Verify by probe (U5). |
| A6 | The sync never adopts an unmarked instance. The spike's hand-made `pi-scout` is replaced in S1 (backup first). |
| A7 | `/t3-sync-agents` is registered whenever the extension loads. No separate CLI. |
| A8 | Result shape: `structuredContent = { launches: [ { name, agent, taskId, childThreadId, providerInstanceId, model, status } ] }` for single launches and batches. `details` never contains a `results` array (T3 would draw a second, native subagent card). |
| A9 | `session-mode: fork` is a gap: the child starts fresh; the sync output and the launch result say so. |
| A10 | The timeout timer runs per child run, from run start to run end. A follow-up run gets a new timer. |
| A11 | After `caller_ping`, the child runtime blocks further tool calls in that run. |
| A12 | T3 settings path: `~/.t3/userdata/settings.json`, overridable by the environment variable `PI_T3_SETTINGS_PATH` (tests and non-standard installs). |
| A13 | Managed instance `binaryPath` is copied from the main instance; when the main instance has none, the sync uses `pi` resolved from `PATH`. |

### Modules

- **Takeover.** Runs only when `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN` are both present (presence only; values are never read). At load: add `subagent` and `subagent_resume` to `PI_DENY_TOOLS`. At session start: restore the original value, and remove pi-subagents' `subagent_kill` from the active tools. Registers the T3 `subagent` tool. ADR 0001.
- **Agent catalog.** Reads global agent definitions with the pi-subagents parsing rules (one regex per `key: value` line; `env` and `deny-env` accept a `|` block; `enabled: false` skips the file). Detects project agents in the current working directory to give the D18 error.
- **Instance planner.** Pure function from one agent definition plus host facts (home path, installed packages, skill locations, main instance binary path) to the expected managed instance entry. The sync and the stale check both use it, so they always agree.
- **Sync command.** `/t3-sync-agents [--prune] [--yes]`. Plans, shows, confirms, backs up, writes, reports.
- **Launch planner.** Parent side. From tool parameters, caller identity, the agent catalog and a settings snapshot to either a validation error or a list of `delegate_task` calls with fully built first messages.
- **Live-children ledger.** Parent side, in memory per Pi process. Adds a task id on launch. Removes it when a wake for it is observed (raw input event) or when a `task_cancel` result for it is observed (tool result event).
- **Child runtime.** Runs only in a managed instance (identity variable present). Strips the frontmatter from the prompt, reads and strips the budget header, registers `caller_ping`, deactivates `subagent` when the budget is 0, runs context warnings and the time limit.

### Managed instance shape

- Id `pi-<agent>`. The agent name must match `[A-Za-z0-9_-]` and the id must be at most 64 characters; otherwise the sync skips the agent and reports it.
- `driver: "pi"`, `displayName: "Pi <agent>"`, `enabled` from D12.
- `environment`: `PI_T3_AGENT=<agent>` (caller identity) plus the agent's `env` entries, all with `sensitive: false`. Keys reserved for this extension and pi-subagents spawn variables are dropped from `env`.
- `config.binaryPath` (A13), `config.launchArgs`, `config.managedBy = "pi-t3-subagents"` (ownership marker).
- Launch arguments use long flags only and absolute paths, quoted when they contain spaces. T3 does no `~` expansion and rejects short flags it does not know. The extension's own `--extension` argument comes before any extension that can register `subagent`. The sync refuses arguments that T3 reserves (`--mode`, `--session`, `--session-id`, `--no-session`, `--resume`, `--continue`, `--fork`, `--print`, `--export`, `--help`, `--list-models`, `--version`).

### Field mapping

"Launch" = instance launch arguments or environment (sync). "Parent" = launch planner rule. "Child" = child runtime. Every field that pi-subagents parses is listed.

| Field | T3 mapping |
|---|---|
| name | Launch: instance id, display name, `PI_T3_AGENT`. |
| description | Not sent to the child. pi-subagents' roster in the parent stays the model's agent list (verify, U10). |
| model | Launch: `--model <ref>` when set. Parent: A1 when absent (inherit from the parent). |
| thinking | Launch: `--thinking <level>` when set. Parent: A1. |
| allow-model-override | Parent: when false, drop the `model` and `thinking` parameters, as pi-subagents does. |
| allowed-models | Parent: validate the override before launch; the agent's own default is always allowed; the error lists the allowed refs. |
| tools | Launch: absent or `all`: no flag. `none`: `--no-builtin-tools`. List: `--tools <list>` plus protocol tools: `caller_ping` always; for agents that may spawn also `subagent`, `mcp__t3-code__delegate_task`, `mcp__t3-code__task_status`, `mcp__t3-code__task_cancel`, `mcp__t3-code__t3_thread_send`. |
| deny-tools | Launch: `--exclude-tools <list>`, plus `subagent` when the agent may not spawn. |
| extensions | Launch: absent or `all`: no flag (the extension's own `--extension` is still first). `none` or a list: `--no-extensions`, then this extension, Pi's built-in MCP and tool-search (A5), then each entry. Entries: `~` expanded, relative paths resolved from the agents folder, installed `npm:` and `git:` specs replaced by their installed path as pi-subagents does; other specs passed through. |
| skills | Launch: absent or `all`: no flag. `none`: `--no-skills`. List: `--no-skills` plus `--skill <absolute path>` per name. Unknown names: the agent is skipped with a report. `=auto` and `=manual` annotations are removed (gap, D9). |
| inject-skills | Parent: prepend each skill as a `<skill name="...">` block to the first message, in pi-subagents' format. Same errors as pi-subagents. |
| system-prompt | Launch: `replace`: `--system-prompt <agent file>`. `append` with `inherit-append-system: false`: `--append-system-prompt <agent file>`. Child: strip the frontmatter in both cases. `append` with `inherit-append-system: true`: the child appends the body before each run. Absent: Parent puts the body into the first message as a role block. |
| inherit-append-system | Launch: true: no flag. False: `--append-system-prompt ""` (suppresses APPEND_SYSTEM.md), unless the agent file is already passed with that flag. |
| env | Launch: environment entries (see the shape). |
| mode | Parent: chooses the mode hint in the first message (background or interactive wording). T3 hosts both the same way. |
| async | Parent: true: `delegate_task` mode `async`. False: A3. |
| auto-exit | Parent: chooses the mode hint (complete autonomously plus summary, or the T3 interactive wording). No process exit in T3. |
| timeout | Child: hard stop of the run at the limit (A10). |
| timeout-warn-threshold | Child: one wrap-up steer at the threshold. |
| context-warn-threshold, context-warn-step | Child: wrap-up steers as in pi-subagents. |
| report-context-usage | Gap: T3 owns the wake text. |
| spawning | Parent: allowlist check against the caller (`PI_T3_AGENT`; absent means root, which may launch any agent visible to root). Launch: tool exposure (see tools and deny-tools). Absent means false. |
| spawn-depth | Parent and child: exact budget (D10, ADR 0004). Child budget = min(child `spawn-depth` or 1, caller budget minus 1). The root budget is unlimited. Budget 0: the child deactivates `subagent`; a launch fails with "Spawn budget is exhausted." |
| spawn-width | Parent: batch size check and live-children check; hard maximum 16. |
| session-mode | `lineage-only`: native (T3 child threads start fresh with lineage). `fork`: gap (A9). |
| trust-project | Launch: `--approve` for interactive agents with `trust-project: true`, otherwise `--no-approve`, as pi-subagents does. |
| no-context-files | Launch: `--no-context-files`. |
| task-expansion | Parent: `shell` expands inline and fenced shell blocks in the task before launch, as pi-subagents does: 30 seconds per command, in the parent's working directory. |
| visible-to | Parent: check against the caller. |
| enabled | Sync: D12. Parent: launch error. |
| flags | Launch: appended last. A reserved T3 flag makes the sync skip the agent with a report. |
| cwd | Gap: a T3 child uses the thread's working directory. |
| deny-env | Gap: T3 merges the instance environment into the host environment and cannot remove inherited variables. |
| no-session | Gap: T3 owns sessions. |
| idle-timeout, on-timeout, parent-close-policy, llm-as-a-verifier fields | Gaps. |

The sync output lists gaps once per agent that uses them; the README lists all gaps.

### Launch flow (parent side)

1. Validate the whole call before any bridge call: parameter rules from pi-subagents (`name` pattern and length, non-empty `title`, `agent` present), agent exists and is enabled and global, not the caller's own agent, `visible-to`, `spawning`, spawn budget, batch size and live children against `spawn-width`, model override rules, task expansion success, instance present and not stale, bridge tool `mcp__t3-code__delegate_task` present in the callable tools.
2. Build each first message, in this order: budget header line, injected skills, role block (only when `system-prompt` is absent), mode hint, expanded task, summary instruction (only with the autonomous hint).
3. Call `delegate_task` through `ctx.executeTool` once per child, in array order, with `task`, `title`, `mode`, `target { providerInstanceId, model, options }` and `clientRequestId` (A1, A2, A3). Add each task id to the live-children ledger.
4. On a mid-batch launch failure: earlier children keep running; throw an error that names the failed child and lists the started task ids and child thread ids.
5. Return the A8 shape. The text names, for each child: stop with `task_cancel {taskId}`; continue after it finishes with `t3_thread_send {threadId: childThreadId, message}`; read with `task_status {taskId}`, which marks the result read and suppresses the wake; end your turn now, completion wakes this thread.

Errors throw (spike round 2 rule). No error is reported through `details`.

Budget header: one first line `<!-- pi-t3-subagents:v1 {"budget":<n>,"caller":"<agent or root>"} -->`. The child runtime removes it from the first user input and stores the budget in the session. A first message without the header gives the agent's own `spawn-depth` (or 1). If the header is present but cannot be read, the child sets the budget to 0.

Mode hints in T3:

- Background, or `auto-exit: true`: "Complete your task autonomously." and the summary instruction, as pi-subagents.
- Interactive with `auto-exit: false`: "You run in a T3 Code child thread. The user can open this thread and reply. Ask questions with ask_user when it is available. When the work is done, end your turn with your final report; your caller is woken with it. The user may continue this thread later."

### Child runtime

- Prompt: before each run, remove a leading frontmatter block from the prompt section that holds the agent file text. Never change other sections.
- Caller ping: tool `caller_ping { message }`. Result text: end the turn now; the final reply must start with the line `CALLER PING` followed by the message; the caller is woken with it and continues this thread. Further tool calls in that run are blocked with that reason (A11).
- Context warnings: the same thresholds, steps and intent as pi-subagents: a steer message that tells the child to wrap up and write its report.
- Time limit: at `timeout-warn-threshold` one steer to wrap up; at `timeout` the run is aborted. The parent receives T3's wake with the final status; S6 records which status T3 shows.
- Spawn budget: when the stored budget is 0, `subagent` is not active.

### Sync flow

1. Read the global agents and the current T3 settings.
2. Plan per agent: add, update, unchanged, disable (agent removed or disabled), prune (only with `--prune`, only disabled managed instances), conflict (id exists without the marker), skip (invalid name, unknown skill, reserved flag). Collect gap notes. Check the main instance for the extension's launch argument; warn if it is missing.
3. Show the plan. If nothing changes: report "up to date" and stop without a write or a backup.
4. Ask for confirmation through the UI. Without a UI, require `--yes`.
5. Read the settings file again; if it changed after step 1, stop and ask the user to run the sync again.
6. Save a timestamped backup; delete the oldest backups so that 10 remain.
7. Write to a temporary file in the same folder, then rename it over `settings.json`. Change only the `providerInstances` entries that the plan names; keep all other content.
8. Report the counts, skipped agents, conflicts, gap notes and the main instance warning.

### T3 contracts the extension relies on

- `delegate_task` input `{ task, title, mode, target { providerInstanceId, model, options }, clientRequestId }`; result data at `structuredContent.structuredContent` through the bridge; failure as an MCP error result.
- Bridge tool exposure: `delegate_task`, `task_status` and `orchestrator_capabilities` are direct (callable only while active); the others are deferred.
- Wake text: `Delegated task <taskId> (<title>) [<status>]:` plus the child's last reply, or the short form that points to `task_status` when 16,000 bytes are exceeded.
- `model: "default"` keeps the instance's launch model and accepts no options.
- Instance `config` keeps unknown keys; instance ids match `^[a-zA-Z][a-zA-Z0-9_-]*$`, at most 64 characters.
- T3 tokenizes `launchArgs` like a shell without expansion and appends its bridge extension last.
- Children inherit the parent's runtime mode and cannot exceed it.

Re-check these after a T3 update; the bundle in the installed app is the authority.

## Testing Decisions

Good tests check behavior that Pi, T3 or the user can observe: tools registered and active, the arguments sent to the bridge, the first message text, thrown errors, settings file content, backups. They do not check internal function structure. Expected values come from this spec, from pi-subagents behavior cited in the field map, and from the T3 facts; never from the output of the code under test.

Layers:

1. **Main seam: fake Pi host plus fake T3 bridge.** Load the extension factory against a fake extension API that records registered tools, commands, event handlers and active tools. Calls to `ctx.executeTool("mcp__t3-code__delegate_task", ...)` go to a fake bridge that records arguments and returns T3-shaped results or errors. The sync runs against a temporary home folder and a temporary settings file (A12). Fixture agent definitions cover every row of the field mapping table. Run with Bun's test runner through `heavy`; S1 adds the test setup. This repository has no tests yet; the spike probe (`probe.ts` in the spike artifacts) is prior art for layer 2.
2. **Real Pi probes.** `pi --mode rpc --no-session` with a probe extension that logs active tools and their source, with fake T3 variables set and `PI_DENY_TOOLS` unset in the probe environment. Use for load order, takeover, launch-argument effects and prompt content (the session file system message).
3. **Live T3 Nightly e2e.** Per slice, in the scratch project `~/Dev/scratch/t3-subagents-e2e` (a throwaway git repository added to T3 once; S1 creates it). Drive the T3 web UI with `agent-browser-chrome`. Default runtime mode: Full access, except where a slice says otherwise.

Live e2e hygiene (D5):

- Pair with a 15-minute token from `t3 auth pairing create`. Keep the token in a temporary file, never in reports or logs.
- After the run, revoke the browser session with `t3 auth session revoke`, confirm with `t3 auth session list`, and delete the token file.
- Temporary e2e agents use the name prefix `t3e2e-`. Remove their files and run `/t3-sync-agents --prune` after the run.
- Put evidence (screenshots, session file extracts, thread text) in the slice report folder under `~/.pi/artifacts/worker/`.
- Do not restart the T3 server. Do not change T3 settings except through the sync command.

Unverified facts, each closed by a slice acceptance check:

| Id | Fact to verify | Slice |
|---|---|---|
| U1 | Two approvals per launch in supervised modes (`approval-required`). | S8 |
| U2 | Named `mcp__t3-code__*` entries in `--tools` keep those bridge tools active in a child. | S4 |
| U3 | A parent on the main instance can call the deferred `task_cancel` and `t3_thread_send`. | S5 |
| U4 | `config.managedBy` survives a T3 UI settings change. | S1 |
| U5 | With `--no-extensions` plus built-in MCP and tool-search, a child does not get the whole bridge catalog as active tools. | S2 |
| U6 | Frontmatter removal before the run reaches the model request. | S2 |
| U7 | The raw input event can remove the budget header from the first prompt that T3 sends. | S4 |
| U8 | The parent's raw input event sees wakes, including steered and batched wakes. | S3 |
| U9 | Whether a user stop in a child thread wakes the parent (ledger drift). | S3 |
| U10 | pi-subagents still injects its roster when its `subagent` tool is denied. | S2 |
| U11 | `/t3-sync-agents` appears in the T3 composer. | S1 |

## Delivery Slices

Each slice is one worktree (`wt new s<N>-<slug> <repo>`), landed with `wt land`. Every slice ends with its affected tests through `heavy`, the probes it names, and a live e2e under the hygiene rules. Order: S1, S2, then S3 and S4 in sequence; S5, S6 and S7 after S2; S8 last. S4 and S5 both change the tool lists that the sync plans; land them one after the other.

### S1: Sync command creates managed instances

Blocked by: none.

Delivers: `/t3-sync-agents` turns all enabled global agents into managed instances in T3, with plan, confirmation, backup and atomic write. Also sets up the test runner and the scratch project, and replaces the spike's hand-made `pi-scout`.

- [ ] Layer 1: for fixture agents covering every field-mapping row, the planned instance entries equal the expected entries written from this spec.
- [ ] Layer 1: a second sync reports "up to date" and leaves the settings file and the backup folder unchanged.
- [ ] Layer 1: a removed agent and an `enabled: false` agent give `enabled: false`; `--prune` deletes only disabled managed instances.
- [ ] Layer 1: an unmarked instance with a planned id is not changed and is reported as a conflict; the main instance is never changed; a missing extension argument in the main instance gives a warning.
- [ ] Layer 1: invalid names, unknown skills and reserved flags skip the agent with a reason; generated launch arguments contain only long flags and absolute paths.
- [ ] Layer 1: a settings change between plan and write stops the sync; backups are timestamped and only 10 remain; without a UI and without `--yes` there is no write.
- [ ] Layer 2: for each of the owner's 10 agents, Pi starts with the generated launch arguments and fake T3 variables without a duplicate-tool error, and `subagent` (when present) comes from this extension.
- [ ] Live: after one sync, T3 lists all 10 managed instances as available without a server restart. The command appears in the composer (U11). The marker survives a T3 UI settings change (U4). The old `pi-scout` is replaced and its backup exists.

### S2: Launch any synced agent as a T3 child

Blocked by: S1.

Delivers: the T3 `subagent` tool launches one child of any global agent with full validation, first-message assembly, the model and thinking rules, the stale check, `async: false` support, prompt frontmatter removal in the child, and the `PI_DENY_TOOLS` restore. Removes the spike prompt copy from the repository.

- [ ] Layer 1: each validation error in "Launch flow" step 1 throws before any bridge call, with a message that names the cause.
- [ ] Layer 1: bridge arguments follow A1, A2 and A3 for these cases: no override, model override inside the allowed models, thinking-only override, override with `allow-model-override: false`, agent without a model.
- [ ] Layer 1: first messages for fixture agents match the expected text for: injected skills, absent `system-prompt`, background hint, interactive hint, shell task expansion.
- [ ] Layer 1: the result has the A8 shape and no `details.results`.
- [ ] Layer 2: a child session started with a managed instance's arguments has a prompt that starts with the agent body and contains no frontmatter (U6); `PI_DENY_TOOLS` in a bash call equals its value before the session started.
- [ ] Live: in the scratch project, the parent launches `scout` with a model override from its allowed models, and `worker` with a shell-expanded brief on a trivial task. Both child threads show lineage and the expected model; both wakes arrive.
- [ ] Live: after a change to an agent's `thinking` without a sync, a launch of that agent fails with the sync message.
- [ ] Live: the parent model still receives pi-subagents' roster (U10); a child of an agent with an extension list does not have the whole bridge catalog active (U5).

### S3: Batches and spawn width

Blocked by: S2.

Delivers: `children[]` launches with all-or-nothing validation, sequential launch, partial-failure reporting, and the live-children ledger for `spawn-width`.

- [ ] Layer 1: one invalid child means no bridge call; a batch larger than the width fails before launch.
- [ ] Layer 1: when the fake bridge fails the second of three children, the first stays recorded as started, the third is never sent, and the error lists the first child's ids.
- [ ] Layer 1: the ledger adds launches and removes tasks on wake text (full form, short `task_status` form, several tasks in one wake) and on `task_cancel` results; a launch beyond the width fails while children are live.
- [ ] Live: a batch of two scouts launches two child threads; both wakes arrive and leave the ledger (U8). Record whether a user stop in a child thread wakes the parent (U9) and document the drift case.

### S4: Nested launches and exact spawn depth

Blocked by: S3.

Delivers: agents that may spawn can launch from child threads; caller identity, `spawning`, `visible-to`, the self-launch guard and the exact budget header (ADR 0004).

- [ ] Layer 1: the header carries min(child depth, caller budget minus 1); budget 0 deactivates `subagent` in the child; a missing header gives the agent's own depth; an unreadable header gives 0.
- [ ] Layer 1: the caller's `spawning` list, the target's `visible-to` and the self-launch guard each block with a clear error.
- [ ] Layer 2: an instance with a fixed tool list that may spawn has `subagent` and the named bridge tools active (U2); an instance that may not spawn has no `subagent`.
- [ ] Live: an `architect` child launches a `scout` grandchild; the grandchild's wake reaches the architect thread and the architect's wake reaches root. The model in the architect thread does not see the header (U7).
- [ ] Live: a `design` child launched by `architect` cannot launch (budget exhausted), and a `scout` child has no `subagent` tool.

### S5: Child lifecycle through T3 tools, and caller ping

Blocked by: S2.

Delivers: pi-subagents' kill and resume tools hidden in T3, the launch result guidance for `task_cancel`, `t3_thread_send` and `task_status`, and the `caller_ping` tool in managed children.

- [ ] Layer 1: in a T3 session pi-subagents does not register `subagent_resume` and `subagent_kill` is not active; outside T3 both are unchanged.
- [ ] Layer 1: after `caller_ping`, other tool calls in that run are blocked with the ping reason; the tool exists only in managed children.
- [ ] Live: the parent stops a running child with `task_cancel` (U3) and the child stops; the parent continues a finished child with `t3_thread_send`, the child keeps its context, and the parent is woken again.
- [ ] Live: a child that calls `caller_ping` ends its run; the parent's wake text starts the reply with `CALLER PING`; the parent continues the child and receives the final wake.

### S6: Context warnings and time limit in children

Blocked by: S2.

Delivers: the child runtime enforces `context-warn-threshold`, `context-warn-step`, `timeout-warn-threshold` and `timeout` per run.

- [ ] Layer 1: with a fake clock and fake context usage, the steers and the abort happen at the expected points and only once per step; a follow-up run starts a new timer.
- [ ] Live: a temporary `t3e2e-timeout` agent with a very short limit gets the warning steer, its run stops at the limit, and the parent wake shows the final status. Record that status for the README.

### S7: Interactive agents in T3

Blocked by: S2.

Delivers: interactive agents with `auto-exit: false` run as child threads that the user steers; `ask_user` appears as T3 question cards.

- [ ] Layer 1: the interactive mode hint is used for `mode: interactive` with `auto-exit: false` and nowhere else.
- [ ] Live: a temporary `t3e2e-interactive` agent (pi-ask in its extension list, a low-cost model) asks one `ask_user` question. The question card appears in the child thread; the answer given in the browser reaches the child; the child's final reply wakes the parent. A follow-up typed in the finished child thread wakes the parent again (documented).

### S8: README and supervised-mode check

Blocked by: S3, S4, S5, S6, S7.

Delivers: a README for any pi-subagents user: what the extension does, setup (add the extension's launch argument to the main Pi instance, run `/t3-sync-agents`), the field mapping with gaps, the lifecycle with T3 tools, caller ping, supervised-mode behavior, risks; and an updated header comment in the extension entry file.

- [ ] Live: in `approval-required` mode, one launch shows the approval prompts that the README describes (U1), and the child inherits the mode.
- [ ] The slice worker follows the README in the scratch project from a main instance without the extension, and gets a working `scout` launch.
- [ ] The README lists every gap from the field mapping table and links the ADRs.

## Out of Scope

- Changes to T3 Code or pi-subagents.
- Project agents and per-project instances (D18, deferred follow-up).
- Skill annotations `=auto` and `=manual` (D9).
- The gaps in the field mapping table.
- A GitHub repository, issues, or a published package.
- A separate command-line sync tool (A7).
- Bypassing the T3 bridge to save one approval (D16).

## Further Notes

Risks:

- **The takeover depends on pi-subagents internals** (ADR 0001). A change in pi-subagents can stop every T3 Pi session at startup. After any pi-subagents or Pi update, run the layer 2 probe from S1 again.
- **Load and cost.** T3 runs model and command discovery for each managed instance, per project. Ten instances add ten discovery runs. Each discovery loads the instance's extensions without T3 variables, so the extension must stay quiet there.
- **Ledger drift.** A wake that the parent never sees (for example after a Pi process restart, or a user stop if U9 shows no wake) leaves a task counted as live until the process restarts.
- **Wake size.** The parent sees at most 16,000 bytes of child replies inline per wake. Agents that return long reports must write them to files.
- **Supervised children.** In async mode the parent gets no signal when a child waits for an approval in its own thread.
- **T3 Nightly changes.** The T3 contracts above come from one nightly build. Re-check them after an update.

Rollback: restore the newest backup from `~/.pi/agent/t3-subagents/backups/` over `~/.t3/userdata/settings.json`, and remove the extension's `--extension` argument from the main instance.

OPEN: none. Deferred: project agents (D18), skill annotations (D9).
