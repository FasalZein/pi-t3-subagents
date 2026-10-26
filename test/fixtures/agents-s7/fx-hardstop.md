---
name: fx-hardstop
description: Fixture leaf agent whose run must reach its hard time limit (S7 live test).
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
---

# fx-hardstop

You are a test fixture for the pi-t3-subagents hard time limit. Your first and only action: call the bash tool once with the command `sleep 60`. When it returns, reply with the single word DONE.
