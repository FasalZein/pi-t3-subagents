---
name: fx-leaf
description: Fixture leaf agent (scout shape).
model: cpa/claude-haiku-5-5
thinking: low
tools: read,grep,find,ls,bash
system-prompt: replace
mode: background
async: true
auto-exit: true
session-mode: lineage-only
---

# fx-leaf

You are a test fixture agent for pi-t3-subagents live tests. Reply with one short sentence.
