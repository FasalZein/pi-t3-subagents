/**
 * Select the host Pi for layer 2 probes and validate it.
 *
 * `bun run` puts node_modules/.bin first on PATH, and the type-only dev dependency installs
 * an older `pi` there. The probes must test the Pi that T3 runs, so this ignores every PATH
 * entry inside node_modules, unless PROBE_PI names an executable explicitly.
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Oldest Pi the takeover is proven against (spec baseline: Pi 1.4.0). */
export const MIN_PI_VERSION = "1.4.0";
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface HostPi {
	/** The executable that the probes start. */
	path: string;
	realPath: string;
	version: string;
	/** Root of the @earendil-works/pi-coding-agent package behind the executable. */
	packageDir: string;
}

/** PATH without node_modules/.bin entries, for the probe processes as well. */
export function hostPath(path = process.env.PATH ?? ""): string {
	return path
		.split(":")
		.filter((entry) => entry && !entry.includes("node_modules"))
		.join(":");
}

function findOnPath(name: string): string | undefined {
	for (const dir of hostPath().split(":")) {
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

let cached: HostPi | undefined;

export function hostPi(): HostPi {
	if (cached) return cached;
	const path = process.env.PROBE_PI ?? findOnPath("pi");
	if (!path) throw new Error("probe: no pi executable outside node_modules on PATH; set PROBE_PI");
	const realPath = realpathSync(path);
	let packageDir = dirname(realPath);
	while (!(existsSync(join(packageDir, "package.json")) && JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).name === PACKAGE_NAME)) {
		const parent = dirname(packageDir);
		if (parent === packageDir) throw new Error(`probe: ${realPath} is not inside ${PACKAGE_NAME}`);
		packageDir = parent;
	}
	const run = Bun.spawnSync([path, "--version"], { env: { ...process.env, PATH: hostPath() } });
	const version = new TextDecoder().decode(run.stdout).trim() || new TextDecoder().decode(run.stderr).trim();
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`probe: ${path} --version printed "${version}"`);
	if (compareVersions(version, MIN_PI_VERSION) < 0) throw new Error(`probe: ${path} is Pi ${version}; the probes need Pi ${MIN_PI_VERSION} or newer`);
	const packageVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
	if (packageVersion !== version) throw new Error(`probe: ${path} prints ${version} but its package is ${packageVersion}`);
	cached = { path, realPath, version, packageDir };
	return cached;
}
