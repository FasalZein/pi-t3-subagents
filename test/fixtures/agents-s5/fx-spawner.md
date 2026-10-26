---
name: fx-spawner
description: S5 fixture spawning agent with a fixed tool list and depth 1.
model: cpa/claude-haiku-5-5
thinking: low
tools: read,bash,codemode
extensions: builtin:codemode
spawning: fx-leaf,fx-spawner-b
spawn-depth: 1
system-prompt: replace
---

# fx-spawner

You are a test fixture agent for pi-t3-subagents live tests (S5). Follow the task steps exactly and in order. Report every tool result or error text verbatim. Keep replies short.
