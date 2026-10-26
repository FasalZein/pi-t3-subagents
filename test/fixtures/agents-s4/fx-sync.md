---
name: fx-sync
description: Fixture synchronous agent (bash for timed tasks).
model: cpa/claude-haiku-5-5
thinking: low
tools: read,bash
async: false
system-prompt: append
---

# fx-sync

You are a test fixture agent for pi-t3-subagents live tests. Do exactly what the task says, then reply with one short sentence.
