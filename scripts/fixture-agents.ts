/**
 * Fixture agent folders for live tests and the sync tests (spec "Live e2e rules").
 *
 * - `test/fixtures/agents/` is the shared set (S2-S3). Its sync inventory is pinned by
 *   test/unit/sync.test.ts; S4-S8 do not add files to it.
 * - `test/fixtures/agents-<slice>/` (for example `agents-s4/`) is one slice's own set. It is
 *   self-contained: it holds every agent that slice's live test needs, copies of shared
 *   fixtures included, because PI_T3_AGENTS_DIR names one folder.
 *
 * The live-test setup selects the slice folder when it exists, else the shared folder.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES_ROOT = join(import.meta.dir, "..", "test", "fixtures");
export const SHARED_AGENTS = "agents";
const SLICE_PREFIX = "agents-";

/** The agents folder the live test of `slice` uses: `agents-<slice>` when present, else the shared one. */
export function fixtureAgentsDir(slice: string, root: string = FIXTURES_ROOT): string {
	const own = join(root, `${SLICE_PREFIX}${slice}`);
	return existsSync(own) ? own : join(root, SHARED_AGENTS);
}

/** Every slice folder under `root`, as [slice, absolute path], sorted by slice. */
export function sliceAgentDirs(root: string = FIXTURES_ROOT): Array<[string, string]> {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(SLICE_PREFIX))
		.map((entry): [string, string] => [entry.name.slice(SLICE_PREFIX.length), join(root, entry.name)])
		.sort(([a], [b]) => a.localeCompare(b));
}
