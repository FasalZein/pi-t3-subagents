---
name: fx-limited
description: Fixture leaf agent with a very short time limit (S7 live test).
model: cpa/claude-haiku-5-5
thinking: low
tools: bash
system-prompt: replace
mode: background
async: true
auto-exit: true
session-mode: lineage-only
timeout: 20
timeout-warn-threshold: 25%
context-warn-threshold: 80%
context-warn-step: 5%
---

# fx-limited

You are a test fixture for the pi-t3-subagents time limit. Do exactly these steps, one tool call at a time:

1. Run `sleep 8` with the bash tool.
2. Run `sleep 60` with the bash tool.
3. Reply with the single word DONE.

A message about a time limit is part of this test. When you get one, first reply with one line that starts with `TIME WARNING SEEN:` and quotes its first sentence, then still do step 2.
