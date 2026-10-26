# pi-t3-subagents

Pi extension: inside T3 Code, route pi-subagents launches to T3 `delegate_task` child threads. Spec: `docs/specs/t3-subagents.md`.

## Checks

Install once with `bun install`. Run every check through `heavy`:

- Typecheck: `heavy -- bunx tsc -p tsconfig.json`
- Layer 1 (fake Pi host `test/harness/fake-pi.ts`, fake T3 bridge `test/harness/fake-bridge.ts`): `heavy -- bun test test/unit`
- Layer 2 (real Pi probes; needs `pi` and the installed pi-subagents; the negative probe makes one small model call): `heavy -- bun test test/probe`. The probes use the host `pi` outside `node_modules` (or `PROBE_PI`), require Pi 1.4.0 or newer, and record its path and version.

`@earendil-works/pi-coding-agent` is a dev dependency for types only. It is pinned to 1.3.0 because the host's package age rule blocked 1.4.0 on 2026-10-26; move it to the Pi version under test when allowed.

## Agent skills

### Issue tracker

GitHub Issues in `FasalZein/pi-t3-subagents` via `gh`; specs are files in `docs/specs/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
