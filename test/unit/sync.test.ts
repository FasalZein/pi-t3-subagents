import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../../index.ts";
import { c6SettingsShape, c7LaunchArgs } from "../../src/doctor-checks.ts";
import { runSync } from "../../src/sync.ts";
import { acquireLock, writeSettings } from "../../src/settings-writer.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost } from "../harness/fake-pi.ts";
import { noUi, type TempHost, tempHost, yesUi } from "./sync-helpers.ts";

const BIN = "/opt/test/bin/pi";
const LEAF_EXCLUDES =
	"subagent,mcp__t3-code__delegate_task,mcp__t3-code__create_threads,mcp__t3-code__t3_thread_launch,mcp__t3-code__t3_thread_fork,mcp__t3-code__t3_thread_send,mcp__t3-code__schedule_task";
const SPAWNER_TOOLS = "subagent,mcp__t3-code__delegate_task,mcp__t3-code__task_status,mcp__t3-code__task_cancel,mcp__t3-code__t3_thread_send";

let hosts: TempHost[] = [];
afterEach(() => {
	resetCopyRegistry();
	for (const h of hosts) h.cleanup();
	hosts = [];
});

function host(namespace = "pi-"): TempHost {
	const h = tempHost(namespace);
	hosts.push(h);
	return h;
}

function mainEntry(h: TempHost, withExtension = true) {
	return {
		driver: "pi",
		displayName: "Pi",
		enabled: true,
		config: { binaryPath: BIN, launchArgs: withExtension ? `--extension ${h.extensionPath}` : "" },
	};
}

const sync = (h: TempHost, args = "--yes", extra: Partial<Parameters<typeof runSync>[0]> = {}) =>
	runSync({ args, env: h.env, extensionPath: h.extensionPath, ui: noUi, reloadWaitMs: 0, ...extra });

/** Spec "Managed instance shape": revision = short hash over launchArgs, binaryPath, displayName, enabled, environment without the revision. */
function expectedEntry(opts: { agent: string; namespace: string; launchArgs: string; agentsDir?: string }) {
	const prod = opts.namespace === "pi-";
	const displayName = prod ? `Pi ${opts.agent}` : `Pi ${opts.agent} [${opts.namespace}]`;
	const envNoRev = [
		{ name: "PI_T3_AGENT", value: opts.agent, sensitive: false },
		...(prod
			? []
			: [
					{ name: "PI_T3_NAMESPACE", value: opts.namespace, sensitive: false },
					{ name: "PI_T3_AGENTS_DIR", value: opts.agentsDir, sensitive: false },
				]),
	];
	const revision = createHash("sha256")
		.update(JSON.stringify({ launchArgs: opts.launchArgs, binaryPath: BIN, displayName, enabled: true, environment: envNoRev }))
		.digest("hex")
		.slice(0, 12);
	return {
		driver: "pi",
		displayName,
		enabled: true,
		environment: [envNoRev[0], { name: "PI_T3_REVISION", value: revision, sensitive: false }, ...envNoRev.slice(1)],
		config: { binaryPath: BIN, launchArgs: opts.launchArgs, managedBy: "pi-t3-subagents", namespace: opts.namespace },
	};
}

describe("planned entries (Launch rows of the field mapping)", () => {
	test("leaf, spawner and interactive agents map to the expected entries", async () => {
		const h = host();
		const leaf = h.agent(
			"leaf",
			`name: leaf
model: cpa/claude-haiku-5-5
thinking: low
tools: read,bash
deny-tools: write
skills: tdd, review=auto
system-prompt: replace
no-context-files: true`,
		);
		const spawner = h.agent(
			"spawner",
			`name: spawner
spawning: leaf
tools: read
extensions: builtin:codemode, ./extensions/local.ts, ~/rel-home.ts, npm:foo, npm:missing, /abs/ext.ts
system-prompt: append
flags: --offline`,
		);
		h.agent(
			"chat",
			`name: chat
mode: interactive
trust-project: true
inherit-append-system: true
skills: none
session-mode: fork
cwd: /tmp`,
		);
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.status).toBe("written");
		const instances = h.readSettings().providerInstances;
		const ext = h.extensionPath;
		const C = h.configDir;
		expect(instances["pi-leaf"]).toEqual(
			expectedEntry({
				agent: "leaf",
				namespace: "pi-",
				launchArgs: `--extension ${ext} --model cpa/claude-haiku-5-5 --thinking low --no-context-files --system-prompt ${leaf} --append-system-prompt "" --no-approve --tools read,bash,caller_ping --exclude-tools write,${LEAF_EXCLUDES} --no-skills --skill ${C}/skills/tdd/SKILL.md --skill ${C}/skills/review/SKILL.md`,
			}),
		);
		expect(instances["pi-spawner"]).toEqual(
			expectedEntry({
				agent: "spawner",
				namespace: "pi-",
				launchArgs: `--no-extensions --extension ${ext} --extension builtin:mcp --extension builtin:tool-search --extension builtin:codemode --extension ${C}/extensions/local.ts --extension ${homedir()}/rel-home.ts --extension ${C}/npm/node_modules/foo --extension npm:missing --extension /abs/ext.ts --append-system-prompt ${spawner} --no-approve --tools read,caller_ping,${SPAWNER_TOOLS} --offline`,
			}),
		);
		expect(instances["pi-chat"]).toEqual(
			expectedEntry({ agent: "chat", namespace: "pi-", launchArgs: `--extension ${ext} --approve --exclude-tools ${LEAF_EXCLUDES} --no-skills` }),
		);
		expect(instances.pi).toEqual(mainEntry(h));
		expect(report.text).toContain('gap leaf: skills: "=auto" annotation on review is removed');
		expect(report.text).toContain("gap chat: session-mode: fork");
		expect(report.text).toContain("gap chat: cwd");
	});

	test("namespace entries carry the namespace variables and a namespaced display name", async () => {
		const h = host("t3e2e-s2-");
		h.agent("leaf", "model: cpa/claude-haiku-5-5\ninherit-append-system: true");
		h.writeSettings({ providerInstances: { "t3e2e-s2-main": mainEntry(h) } });
		expect((await sync(h)).status).toBe("written");
		expect(h.readSettings().providerInstances["t3e2e-s2-leaf"]).toEqual(
			expectedEntry({
				agent: "leaf",
				namespace: "t3e2e-s2-",
				agentsDir: h.agentsDir,
				launchArgs: `--extension ${h.extensionPath} --model cpa/claude-haiku-5-5 --no-approve --exclude-tools ${LEAF_EXCLUDES}`,
			}),
		);
	});

	test("paths with spaces are quoted; every flag is long and every path absolute", async () => {
		const h = host();
		h.agent("leaf", "tools: read\nextensions: ./my ext/a.ts\nsystem-prompt: replace");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		await sync(h);
		const args: string = h.readSettings().providerInstances["pi-leaf"].config.launchArgs;
		expect(args).toContain(`--extension "${h.configDir}/my ext/a.ts"`);
		const tokens = args.match(/"[^"]*"|\S+/g)!.map((t) => t.replace(/^"|"$/g, ""));
		for (const [i, t] of tokens.entries()) {
			if (t.startsWith("-")) expect(t.startsWith("--")).toBe(true);
			if (["--extension", "--system-prompt", "--skill"].includes(tokens[i - 1] ?? "") && !t.startsWith("builtin:")) expect(t.startsWith("/")).toBe(true);
		}
	});
});

describe("secrets and gaps", () => {
	test("a dummy secret in env appears in no settings output, plan text or backup; pre-extension variables are gaps", async () => {
		const h = host();
		const SECRET = "dummy-secret-value-4711";
		h.agent("leaf", `model: x/y\nenv: |\n  API_TOKEN=${SECRET}\n  PI_OFFLINE=1`);
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.status).toBe("written");
		expect(report.text).not.toContain(SECRET);
		expect(h.settingsText()).not.toContain(SECRET);
		const backups = join(h.configDir, "t3-subagents", "backups");
		for (const f of readdirSync(backups)) expect(readFileSync(join(backups, f), "utf8")).not.toContain(SECRET);
		expect(report.text).toContain("gap leaf: env: PI_OFFLINE is read by Pi before extensions load");
		expect(report.text).not.toContain("API_TOKEN is read");
	});
});

describe("idempotence, disable and prune", () => {
	test("second sync is up to date and changes no file", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		expect((await sync(h)).status).toBe("written");
		const before = h.settingsText();
		const mtime = statSync(h.settingsPath).mtimeMs;
		const backups = readdirSync(join(h.configDir, "t3-subagents", "backups")).length;
		const second = await sync(h);
		expect(second.status).toBe("up-to-date");
		expect(second.text).toContain("up to date");
		expect(h.settingsText()).toBe(before);
		expect(statSync(h.settingsPath).mtimeMs).toBe(mtime);
		expect(readdirSync(join(h.configDir, "t3-subagents", "backups")).length).toBe(backups);
	});

	test("removed and disabled agents become enabled:false; --prune deletes only disabled managed instances of the same namespace", async () => {
		const h = host();
		h.agent("keep", "model: x/y");
		h.agent("gone", "model: x/y");
		h.agent("off", "model: x/y");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		await sync(h);
		h.agent("off", "model: x/y\nenabled: false");
		writeFileSync(join(h.agentsDir, "gone.md"), "no frontmatter");
		const s = h.readSettings();
		s.providerInstances["t3e2e-s2-off"] = { driver: "pi", enabled: false, config: { managedBy: "pi-t3-subagents", namespace: "t3e2e-s2-" } };
		s.providerInstances["pi-foreign"] = { driver: "pi", enabled: false, config: { managedBy: "pi-t3-subagents", namespace: "t3e2e-s2-" } };
		h.writeSettings(s);
		const report = await sync(h);
		expect(report.status).toBe("written");
		let after = h.readSettings().providerInstances;
		expect(after["pi-gone"].enabled).toBe(false);
		expect(after["pi-off"].enabled).toBe(false);
		expect(after["pi-keep"].enabled).toBe(true);
		const pruned = await sync(h, "--yes --prune");
		expect(pruned.status).toBe("written");
		after = h.readSettings().providerInstances;
		expect(Object.keys(after).sort()).toEqual(["pi", "pi-foreign", "pi-keep", "t3e2e-s2-off"]);
	});
});

describe("ownership and namespaces", () => {
	function seeded(h: TempHost, mainId: string, withExtension: boolean) {
		const owned = (ns: string) => ({ driver: "pi", enabled: true, config: { managedBy: "pi-t3-subagents", namespace: ns, launchArgs: "--old" } });
		return h.writeSettings({
			favorites: ["keep-me"],
			providerInstances: {
				[mainId]: mainEntry(h, withExtension),
				"pi-old": owned("pi-"),
				"t3e2e-s2-old": owned("t3e2e-s2-"),
				"t3e2e-s3-old": owned("t3e2e-s3-"),
				"pi-leaf": { driver: "pi", enabled: true, config: { launchArgs: "--mine" } },
				"t3e2e-s2-leaf": { driver: "pi", enabled: true, config: { launchArgs: "--mine-too" } },
				codex: { driver: "codex" },
			},
		});
	}

	test("production sync never changes t3e2e- entries; unmarked planned id is a conflict; main is untouched and warned", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		h.agent("other", "model: x/y");
		const original = JSON.parse(seeded(h, "pi", false));
		const report = await sync(h);
		const after = h.readSettings();
		expect(after.favorites).toEqual(["keep-me"]);
		for (const id of ["pi", "pi-leaf", "t3e2e-s2-old", "t3e2e-s3-old", "t3e2e-s2-leaf", "codex"]) expect(after.providerInstances[id]).toEqual(original.providerInstances[id]);
		expect(after.providerInstances["pi-old"].enabled).toBe(false);
		expect(after.providerInstances["pi-other"]).toBeDefined();
		expect(report.text).toContain("conflict");
		expect(report.text).toContain("pi-leaf");
		expect(report.text).toContain(`main instance "pi" does not load this extension`);
	});

	test("namespace sync never changes another namespace", async () => {
		const h = host("t3e2e-s2-");
		h.agent("leaf", "model: x/y");
		h.agent("other", "model: x/y");
		const original = JSON.parse(seeded(h, "t3e2e-s2-main", true));
		const report = await sync(h, "--yes --prune");
		const after = h.readSettings();
		for (const id of ["t3e2e-s2-main", "pi-old", "t3e2e-s3-old", "t3e2e-s2-leaf", "pi-leaf", "codex"]) expect(after.providerInstances[id]).toEqual(original.providerInstances[id]);
		// Enabled orphan: --prune disables it first; it is deleted only by a later --prune.
		expect(after.providerInstances["t3e2e-s2-old"].enabled).toBe(false);
		expect(after.providerInstances["t3e2e-s2-other"].config.namespace).toBe("t3e2e-s2-");
		expect(report.text).not.toContain("main instance");
	});
});

describe("repository fixture agents", () => {
	test("the live-test fixtures plan without a skip in a namespace and keep their dummy secret out", async () => {
		const h = host("t3e2e-s2-");
		const fixtures = join(import.meta.dir, "..", "fixtures", "agents");
		const env = { ...h.env, PI_T3_AGENTS_DIR: fixtures };
		h.writeSettings({ providerInstances: { "t3e2e-s2-main": mainEntry(h) } });
		const report = await runSync({ args: "--yes", env, extensionPath: h.extensionPath, ui: noUi, reloadWaitMs: 0 });
		expect(report.status).toBe("written");
		expect(report.plan?.skipped).toEqual([]);
		const ids = Object.keys(h.readSettings().providerInstances).sort();
		expect(ids).toEqual(["t3e2e-s2-fx-env", "t3e2e-s2-fx-interactive", "t3e2e-s2-fx-leaf", "t3e2e-s2-fx-spawner", "t3e2e-s2-fx-sync", "t3e2e-s2-main"]);
		expect(h.settingsText()).not.toContain("fixture-dummy-secret-0000");
		expect(report.text).toContain("gap fx-env: env: PI_OFFLINE");
	});
});

describe("skips", () => {
	test("invalid names, unknown skills, reserved and short flags skip the agent with a reason", async () => {
		const h = host();
		h.agent("bad", "name: bad.name");
		h.agent("noskill", "skills: tdd, nope");
		h.agent("reserved", "flags: --session /tmp/x");
		h.agent("reserved2", "flags: --mode=json");
		h.agent("short", "flags: -x");
		h.agent("main", "name: pi-main-clash");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.text).toContain('skip bad.name: invalid agent name "bad.name"');
		expect(report.text).toContain('skip noskill: unknown skill "nope"');
		expect(report.text).toContain('skip reserved: flags: "--session" is reserved by T3');
		expect(report.text).toContain('skip reserved2: flags: "--mode" is reserved by T3');
		expect(report.text).toContain('skip short: flags: short flag "-x"');
		const ids = Object.keys(h.readSettings().providerInstances);
		expect(ids).toEqual(["pi", "pi-pi-main-clash"]);
	});
});

describe("review regressions", () => {
	test("credential flags (both forms) skip the agent; the key is in no settings, plan text or backup", async () => {
		const h = host();
		const KEY = "sk-dummy-credential-9431";
		h.agent("spaced", `model: x/y\nflags: --api-key ${KEY}`);
		h.agent("equals", `model: x/y\nflags: --api-key=${KEY}`);
		h.agent("ok", "model: x/y");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.status).toBe("written");
		expect(report.text).toContain('skip spaced: flags: "--api-key" carries a credential');
		expect(report.text).toContain('skip equals: flags: "--api-key" carries a credential');
		expect(report.text).not.toContain(KEY);
		expect(h.settingsText()).not.toContain(KEY);
		const backups = join(h.configDir, "t3-subagents", "backups");
		for (const f of readdirSync(backups)) expect(readFileSync(join(backups, f), "utf8")).not.toContain(KEY);
		expect(Object.keys(h.readSettings().providerInstances).sort()).toEqual(["pi", "pi-ok"]);
	});

	test("flags that T3 would reject (--provider without --model, a positional token) skip the agent", async () => {
		const h = host();
		h.agent("provider", "flags: --provider anthropic");
		h.agent("positional", "flags: --no-approve hello");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.text).toContain('skip provider: flags: "--provider" needs "--model"');
		expect(report.text).toContain("skip positional: flags: a positional argument is not supported by T3");
	});

	test("--prune right after an agent is removed disables the instance and does not delete it", async () => {
		const h = host();
		h.agent("gone", "model: x/y");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		await sync(h);
		writeFileSync(join(h.agentsDir, "gone.md"), "no frontmatter");
		const first = await sync(h, "--yes --prune");
		expect(first.plan?.actions.map((a) => `${a.kind}:${a.id}`)).toEqual(["disable:pi-gone"]);
		expect(h.readSettings().providerInstances["pi-gone"].enabled).toBe(false);
		await sync(h, "--yes --prune");
		expect(h.readSettings().providerInstances["pi-gone"]).toBeUndefined();
	});

	test("two files with one agent name give one instance (last enabled file wins); the second sync is up to date", async () => {
		const h = host();
		h.agent("a-dup", "name: dup\nmodel: x/first");
		h.agent("b-dup", "name: dup\nmodel: x/second");
		h.agent("c-dup", "name: dup\nmodel: x/third\nenabled: false");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.status).toBe("written");
		expect(report.plan?.actions.filter((a) => a.id === "pi-dup").length).toBe(1);
		expect(h.readSettings().providerInstances["pi-dup"].config.launchArgs).toContain("--model x/second");
		expect((await sync(h)).status).toBe("up-to-date");
	});

	test("skills resolve through Pi's discovery: nested skill folders and configured skill paths", async () => {
		const h = host();
		h.agent("skilled", "skills: nested-skill, configured-skill");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h);
		expect(report.plan?.skipped).toEqual([]);
		const args: string = h.readSettings().providerInstances["pi-skilled"].config.launchArgs;
		expect(args).toContain(`--skill ${h.configDir}/skills/group/nested-skill/SKILL.md`);
		expect(args).toContain(`--skill ${h.root}/extra-skills/configured-skill/SKILL.md`);
	});

	test("pinned npm and git specs become their installed absolute path", async () => {
		const h = host();
		h.agent("pinned", "extensions: npm:foo@1.2.3, git:github.com/acme/tools@v1");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		await sync(h);
		const args: string = h.readSettings().providerInstances["pi-pinned"].config.launchArgs;
		expect(args).toContain(`--extension ${h.configDir}/npm/node_modules/foo `);
		expect(args).toContain(`--extension ${h.configDir}/git/github.com/acme/tools`);
		expect(args).not.toContain("npm:foo");
		expect(args).not.toContain("git:");
	});

	test("C7 fails for --provider without --model and for missing launchArgs; PASS says runtime availability is not checked", async () => {
		const h = host();
		const owned = (launchArgs?: string) => ({ driver: "pi", config: { managedBy: "pi-t3-subagents", namespace: "pi-", ...(launchArgs === undefined ? {} : { launchArgs }) } });
		h.writeSettings({ providerInstances: { pi: mainEntry(h), "pi-bad": owned("--provider anthropic"), "pi-none": owned() } });
		const c7 = await c7LaunchArgs(h.env).run();
		expect(c7.status).toBe("fail");
		expect(c7.detail).toContain('pi-bad: "--provider" needs "--model"');
		expect(c7.detail).toContain("pi-none: config.launchArgs is missing or not a string");
		h.writeSettings({ providerInstances: { pi: mainEntry(h), "pi-good": owned("--model a/b") } });
		const ok = await c7LaunchArgs(h.env).run();
		expect(ok.status).toBe("pass");
		expect(ok.detail).toContain("pi-good: stored enabled");
		expect(ok.detail).toContain("Runtime availability in T3 is not checked here");
	});
});

describe("settings writer interleavings", () => {
	test("a change before the final compare stops the sync and leaves the concurrent content", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const concurrent = `${JSON.stringify({ providerInstances: { pi: mainEntry(h) }, t3: "saved" })}\n`;
		const report = await sync(h, "--yes", { hooks: { beforeFinalCompare: () => writeFileSync(h.settingsPath, concurrent) } });
		expect(report.status).toBe("changed");
		expect(report.text).toContain("settings changed, run the sync again");
		expect(h.settingsText()).toBe(concurrent);
		expect(readdirSync(join(h.root, "t3")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("a write that erases the managed entries after the rename is reported by the verification", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		const original = h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const report = await sync(h, "--yes", { hooks: { afterRename: () => writeFileSync(h.settingsPath, original) } });
		expect(report.status).toBe("lost");
		expect(report.text).toContain("lost to a concurrent T3 settings save; run the sync again");
	});

	test("two writers of this extension serialize on the lock", async () => {
		const h = host();
		const stateDir = join(h.root, "state");
		const events: string[] = [];
		const lock = await acquireLock(h.settingsPath);
		const text = h.writeSettings({ a: 1 });
		const second = writeSettings({
			settingsPath: h.settingsPath,
			stateDir,
			originalText: text,
			nextText: '{"a":2}\n',
			verify: () => [],
			reloadWaitMs: 0,
			hooks: { beforeFinalCompare: () => void events.push("second-writes") },
		});
		await Bun.sleep(200);
		events.push("first-releases");
		lock.release();
		expect((await second).status).toBe("written");
		expect(events).toEqual(["first-releases", "second-writes"]);
	});

	test("two Pi profiles (different agent config folders) that target one settings file share the lock", async () => {
		const h = host();
		const text = h.writeSettings({ a: 1 });
		const events: string[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((r) => (releaseFirst = r));
		const first = writeSettings({
			settingsPath: h.settingsPath,
			stateDir: join(h.root, "profile-a", "t3-subagents"),
			originalText: text,
			nextText: '{"a":2}\n',
			verify: () => [],
			reloadWaitMs: 0,
			hooks: { beforeFinalCompare: async () => { events.push("a-inside"); await gate; events.push("a-leaves"); } },
		});
		await Bun.sleep(50);
		const second = writeSettings({
			settingsPath: h.settingsPath,
			stateDir: join(h.root, "profile-b", "t3-subagents"),
			originalText: text,
			nextText: '{"b":1}\n',
			verify: () => [],
			reloadWaitMs: 0,
			hooks: { beforeFinalCompare: () => void events.push("b-inside") },
		});
		await Bun.sleep(200);
		releaseFirst();
		expect((await first).status).toBe("written");
		// B planned from the old text, so after waiting for A it must stop, not overwrite A's write.
		expect((await second).status).toBe("changed");
		expect(events).toEqual(["a-inside", "a-leaves"]);
		expect(h.settingsText()).toBe('{"a":2}\n');
	});

	test("a stale lock is taken over, and the old holder's release does not delete the new holder's lock", async () => {
		const h = host();
		const { utimesSync } = await import("node:fs");
		const a = await acquireLock(h.settingsPath);
		const old = new Date(Date.now() - 61_000);
		utimesSync(join(h.root, "t3", ".settings.json.pi-t3-subagents.lock"), old, old);
		const b = await acquireLock(h.settingsPath, 500);
		expect(a.owns()).toBe(false);
		a.release();
		expect(b.owns()).toBe(true);
		await expect(acquireLock(h.settingsPath, 200)).rejects.toThrow("settings writer lock is busy");
		b.release();
		const c = await acquireLock(h.settingsPath, 200);
		c.release();
	});

	test("a writer whose lock was taken over does not commit", async () => {
		const h = host();
		const { utimesSync } = await import("node:fs");
		const text = h.writeSettings({ a: 1 });
		let other: Awaited<ReturnType<typeof acquireLock>> | undefined;
		const out = await writeSettings({
			settingsPath: h.settingsPath,
			stateDir: join(h.root, "state"),
			originalText: text,
			nextText: '{"a":2}\n',
			verify: () => [],
			reloadWaitMs: 0,
			hooks: {
				beforeFinalCompare: async () => {
					const old = new Date(Date.now() - 61_000);
					utimesSync(join(h.root, "t3", ".settings.json.pi-t3-subagents.lock"), old, old);
					other = await acquireLock(h.settingsPath, 500);
				},
			},
		});
		expect(out.status).toBe("lock-lost");
		expect(h.settingsText()).toBe(text);
		expect(other?.owns()).toBe(true);
		other?.release();
	});

	test("backups: mode 0600 in a 0700 folder, newest 10 kept", async () => {
		const h = host();
		const stateDir = join(h.root, "state");
		let text = h.writeSettings({ n: 0 });
		for (let n = 1; n <= 12; n++) {
			const next = `{"n":${n}}\n`;
			const out = await writeSettings({ settingsPath: h.settingsPath, stateDir, originalText: text, nextText: next, verify: () => [], reloadWaitMs: 0 });
			expect(out.status).toBe("written");
			text = next;
		}
		const dir = join(stateDir, "backups");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const files = readdirSync(dir).sort();
		expect(files.length).toBe(10);
		for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(dir, files[9]), "utf8")).toBe('{"n":11}\n');
		expect(statSync(h.settingsPath).mode & 0o777).toBe(0o600);
	});

	test("no UI and no --yes means no write; a declined confirm means no write", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		const original = h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const r1 = await sync(h, "");
		expect(r1.status).toBe("needs-yes");
		const r2 = await sync(h, "", { ui: { hasUI: true, confirm: async () => false } });
		expect(r2.status).toBe("declined");
		expect(h.settingsText()).toBe(original);
		const r3 = await sync(h, "", { ui: yesUi });
		expect(r3.status).toBe("written");
	});

	test("an unexpected settings shape is refused (C6) and the doctor checks report it", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		h.writeSettings({ providerInstances: { pi: { driver: "pi", environment: { bad: true } } } });
		const report = await sync(h);
		expect(report.status).toBe("refused");
		expect(report.text).toContain("providerInstances.pi.environment is not an array");
		expect((await c6SettingsShape(h.env).run()).status).toBe("fail");
		h.writeSettings({ providerInstances: { pi: mainEntry(h), "pi-x": { driver: "pi", config: { managedBy: "pi-t3-subagents", namespace: "pi-", launchArgs: "--session y -p" } } } });
		expect((await c6SettingsShape(h.env).run()).status).toBe("pass");
		const c7 = await c7LaunchArgs(h.env).run();
		expect(c7.status).toBe("fail");
		expect(c7.detail).toContain('pi-x: "--session" is reserved by T3');
		expect(c7.detail).toContain('pi-x: "-p" is reserved by T3');
	});
});

describe("entry wiring (S1 seams)", () => {
	test("outside T3 /t3-sync-agents is registered; without UI and --yes it writes nothing", async () => {
		const h = host();
		h.agent("leaf", "model: x/y");
		const original = h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const pi = new FakePiHost();
		await pi.load("/ext/index.ts", createExtension({ ...h.env }, "/ext/index.ts"));
		await pi.startSession();
		expect(pi.tools.size).toBe(0);
		await pi.runCommand("t3-sync-agents");
		expect(pi.notifications.at(-1)?.message).toContain("run /t3-sync-agents --yes");
		expect(pi.notifications.at(-1)?.message).toContain("add: pi-leaf");
		expect(h.settingsText()).toBe(original);
	});

	test("inside T3 the doctor reports C6 and C7", async () => {
		const h = host();
		h.writeSettings({ providerInstances: { pi: mainEntry(h) } });
		const pi = new FakePiHost();
		const env = { ...h.env, T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "fake-token" };
		await pi.load("/ext/index.ts", createExtension(env, "/ext/index.ts"));
		await pi.startSession();
		await pi.runCommand("t3-subagents-doctor");
		const text = String(pi.messages.at(-1)?.content);
		expect(text).toMatch(/^C6 PASS /m);
		expect(text).toMatch(/^C7 PASS .*no managed instances in namespace pi-/m);
	});
});
