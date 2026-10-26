# Carry the spawn budget in a stripped task header

pi-subagents narrows the spawn budget along a chain (a child gets at most its caller's budget minus one), which also stops spawn cycles. T3 Code passes nothing per call to a child except the task text, and instance environment entries are static. We decided that the parent puts a one-line machine header with the child's remaining budget at the start of the task. The wrapper in the child reads it from the first user input, stores it in the session, and removes it before the model sees the message.

## Consequences

- The header is visible in the child thread in the T3 UI.
- A thread that the user starts directly on a managed instance has no header; it gets the agent's own spawn-depth, as if root launched it.
- If the header handling fails, the child must refuse to spawn rather than spawn without a limit.

## Considered options

- Static budget per agent: rejected, it allows deeper chains than pi-subagents and does not stop cycles such as A launches B launches A.
