# Write T3 settings directly, with a narrow window and verification

The sync must add and change provider instances in T3's `settings.json`. T3 offers no route for this: its CLI and its MCP tools cannot edit provider instances, and its own writes are serialized only by a lock inside the T3 server process. We decided that the sync writes the file directly: a lock that serializes this extension's own writers, a private backup, a temporary file, a final compare with the content it planned from, an immediate rename, and a check after T3 reloads that the planned entries exist. We do not claim a guarantee. A T3 settings save that falls into the remaining window can be lost, or can erase the sync; the second case is detected and reported.

## Consequences

- The README states the remaining risk. The sync is a rare, manual action, so the window rarely matters.
- All writes (sync, live-test setup and teardown, rollout) go through one settings writer.
- The own-writer lock sits next to the settings file, so every Pi profile that writes one settings file shares it. The sync never removes a lock on its own (owner decision 2026-10-26): a lock of a live holder on this host is busy and is never broken; any other lock (holder gone, another host, unreadable, malformed) stops the sync with the lock details, and the user removes it once with `/t3-sync-agents --break-lock`, which refuses when the lock changed since it was read. Automatic stale-lock takeover was rejected: two review rounds found races in which an old takeover decision removed a live writer's lock.

## Considered options

- Offline-only writes (T3 stopped): rejected, no sync from T3 threads and no live reload.
- T3's internal WebSocket settings route with an auth session: rejected, it depends on an internal protocol and needs a credential.
