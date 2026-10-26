---
name: fx-env
description: Fixture agent with env values (dummy secret).
model: cpa/claude-haiku-5-5
thinking: low
tools: read,bash
env: |
  FX_DUMMY_SECRET=fixture-dummy-secret-0000
  PI_OFFLINE=1
system-prompt: replace
---

# fx-env

You are a test fixture agent for pi-t3-subagents live tests. Reply with one short sentence.
