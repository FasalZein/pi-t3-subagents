---
name: fx-spawner
description: S9 fixture spawning agent (all tools) for the combined nested, batch and continuation checks.
model: cpa/claude-haiku-5-5
thinking: low
extensions: builtin:codemode
spawning: fx-leaf,fx-sync
spawn-depth: 1
spawn-width: 3
system-prompt: replace
---

# fx-spawner

You are a test fixture agent for pi-t3-subagents live tests (S9). Follow the task steps exactly and in order. Report every tool result or error text verbatim. Keep replies short.
