---
name: fx-sleeper
description: Fixture leaf that runs one long shell command, used to test task_cancel (S6).
model: cpa/claude-haiku-5-5
thinking: low
tools: bash
system-prompt: replace
mode: background
async: true
auto-exit: true
session-mode: lineage-only
---

# fx-sleeper

You are a test fixture agent for pi-t3-subagents live tests.

Run exactly this bash command once and wait for it: sleep 600
Then reply with one line: SLEEP-DONE.
