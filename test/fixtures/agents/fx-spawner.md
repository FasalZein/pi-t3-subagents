---
name: fx-spawner
description: Fixture spawning agent (worker shape) with an extension list.
model: cpa/claude-haiku-5-5
thinking: low
tools: read,bash,codemode
extensions: builtin:codemode
spawning: fx-leaf
spawn-depth: 2
spawn-width: 2
skills: tdd
inject-skills: tdd
system-prompt: replace
inherit-append-system: true
task-expansion: shell
timeout: 600
timeout-warn-threshold: 80%
context-warn-threshold: 80%
---

# fx-spawner

You are a test fixture agent for pi-t3-subagents live tests. Reply with one short sentence.
