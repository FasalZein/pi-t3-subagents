# Write T3 settings directly, with a narrow window and verification

The sync must add and change provider instances in T3's `settings.json`. T3 offers no route for this: its CLI and its MCP tools cannot edit provider instances, and its own writes are serialized only by a lock inside the T3 server process. We decided that the sync writes the file directly: a lock that serializes this extension's own writers, a private backup, a temporary file, a final compare with the content it planned from, an immediate rename, and a check after T3 reloads that the planned entries exist. We do not claim a guarantee. A T3 settings save that falls into the remaining window can be lost, or can erase the sync; the second case is detected and reported.

## Consequences

- The README states the remaining risk. The sync is a rare, manual action, so the window rarely matters.
- All writes (sync, live-test setup and teardown, rollout) go through one settings writer.

## Considered options

- Offline-only writes (T3 stopped): rejected, no sync from T3 threads and no live reload.
- T3's internal WebSocket settings route with an auth session: rejected, it depends on an internal protocol and needs a credential.
