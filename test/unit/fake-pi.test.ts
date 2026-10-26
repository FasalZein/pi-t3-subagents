/**
 * Layer 1 harness contract: FakePiHost runs tool calls through the Pi 1.4.0 pipeline
 * (pi-agent-core agent-loop.js; pi-coding-agent nested-tool-calls.js and agent-session.js).
 * S4 (ledger), S5 (guard), S6 (ping latch) and S7 (run limits) compose on these events,
 * so the expected sequences below come from that Pi source, not from the fake.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { FakePiHost } from "../harness/fake-pi.ts";

const EXT = "/ext/harness-test.ts";
const DELEGATE = "mcp__t3-code__delegate_task";

const text = (value: string) => ({ content: [{ type: "text", text: value }], details: {} });

/** Events as [type, toolCallId, parentToolCallId] for compact sequence assertions. */
function trace(host: FakePiHost) {
	return host.toolEvents.map((e) => [e.type, e.toolCallId, e.parentToolCallId]);
}

/** An extension with a wrapper tool that calls `target` through ctx.executeTool. */
function wrapperExtension(target: string, extra: (pi: ExtensionAPI) => void = () => {}) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "wrapper",
			label: "wrapper",
			description: "calls another tool",
			parameters: {} as any,
			async execute(_id: string, _args: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
				const outcome = await ctx.executeTool(target, { task: "x" });
				return text(`nested ${outcome.isError ? "error" : "ok"}: ${outcome.result.content[0].text}`);
			},
		} as any);
		extra(pi);
	};
}

async function hostWith(...factories: Array<(pi: ExtensionAPI) => void>) {
	const host = new FakePiHost();
	for (const [i, factory] of factories.entries()) await host.load(i === 0 ? EXT : `/ext/other-${i}.ts`, factory);
	await host.startSession();
	return host;
}

describe("model-issued call", () => {
	test("start, tool_call, tool_result, end in order with one id; results flow through", async () => {
		const host = await hostWith((pi) => {
			pi.registerTool({ name: "echo", label: "echo", description: "", parameters: {} as any, execute: async () => text("hi") } as any);
		});
		const call = await host.callTool("echo", { a: 1 });
		expect(call).toEqual({ result: text("hi"), isError: false, toolCallId: "call-1" });
		expect(trace(host)).toEqual([
			["tool_execution_start", "call-1", undefined],
			["tool_call", "call-1", undefined],
			["tool_result", "call-1", undefined],
			["tool_execution_end", "call-1", undefined],
		]);
		expect(host.toolEvents[0].args).toEqual({ a: 1 });
		expect(host.toolEvents.at(-1)).toMatchObject({ result: text("hi"), isError: false });
		// A second model call gets the next id.
		expect((await host.callTool("echo")).toolCallId).toBe("call-2");
	});

	test("tool_result handlers chain and may replace content and isError; end carries the final result", async () => {
		const seen: unknown[] = [];
		const host = await hostWith(
			(pi) => {
				pi.registerTool({ name: "echo", label: "echo", description: "", parameters: {} as any, execute: async () => text("raw") } as any);
				pi.on("tool_result", async (event: any) => ({ content: [{ type: "text", text: `${event.content[0].text}+a` }] }));
			},
			(pi) => {
				pi.on("tool_result", async (event: any) => {
					seen.push(event.content[0].text);
					return { isError: true };
				});
			},
		);
		const call = await host.callTool("echo");
		expect(seen).toEqual(["raw+a"]);
		expect(call.isError).toBe(true);
		expect(call.result.content[0].text).toBe("raw+a");
		expect(host.toolEvents.at(-1)).toMatchObject({ type: "tool_execution_end", isError: true });
	});

	test("a thrown error becomes an error result; tool_result still runs; the call does not reject", async () => {
		const results: boolean[] = [];
		const host = await hostWith((pi) => {
			pi.registerTool({ name: "boom", label: "boom", description: "", parameters: {} as any, execute: async () => { throw new Error("kaput"); } } as any);
			pi.on("tool_result", async (event: any) => void results.push(event.isError));
		});
		const call = await host.callTool("boom");
		expect(call.isError).toBe(true);
		expect(call.result.content[0].text).toBe("kaput");
		expect(results).toEqual([true]);
		expect(trace(host).map(([type]) => type)).toEqual(["tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]);
	});

	test("a block stops later tool_call handlers and skips execute and tool_result", async () => {
		let executed = false;
		let laterHandler = false;
		const host = await hostWith(
			(pi) => {
				pi.registerTool({ name: "guarded", label: "g", description: "", parameters: {} as any, execute: async () => { executed = true; return text("ran"); } } as any);
				pi.on("tool_call", async () => ({ block: true, reason: "no" }));
			},
			(pi) => {
				pi.on("tool_call", async () => void (laterHandler = true));
			},
		);
		const call = await host.callTool("guarded");
		expect(call).toEqual({ blocked: "no", isError: true, toolCallId: "call-1" });
		expect(executed).toBe(false);
		expect(laterHandler).toBe(false);
		expect(trace(host).map(([type]) => type)).toEqual(["tool_execution_start", "tool_call", "tool_execution_end"]);
		expect(host.toolEvents.at(-1)).toMatchObject({ isError: true, result: text("no") });
	});

	test("an aborted signal after tool_call skips execute: 'Operation aborted', no tool_result", async () => {
		const controller = new AbortController();
		let executed = false;
		const host = await hostWith((pi) => {
			pi.registerTool({ name: "slow", label: "s", description: "", parameters: {} as any, execute: async () => { executed = true; return text("ran"); } } as any);
			pi.on("tool_call", async () => void controller.abort());
		});
		const call = await host.callTool("slow", {}, { signal: controller.signal });
		expect(executed).toBe(false);
		expect(call.isError).toBe(true);
		expect(call.result).toEqual(text("Operation aborted"));
		expect(trace(host).map(([type]) => type)).toEqual(["tool_execution_start", "tool_call", "tool_execution_end"]);
	});

	test("an abort during execute reaches the tool's signal; its rejection is an error result", async () => {
		const controller = new AbortController();
		let started!: () => void;
		const running = new Promise<void>((resolve) => (started = resolve));
		const host = await hostWith((pi) => {
			pi.registerTool({
				name: "waiter",
				label: "w",
				description: "",
				parameters: {} as any,
				execute: (_id: string, _a: unknown, signal: AbortSignal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("stopped by abort")));
						started();
					}),
			} as any);
		});
		const pending = host.callTool("waiter", {}, { signal: controller.signal });
		await running;
		controller.abort();
		const call = await pending;
		expect(call.isError).toBe(true);
		expect(call.result.content[0].text).toBe("stopped by abort");
		expect(host.toolEvents.at(-1)).toMatchObject({ type: "tool_execution_end", isError: true });
	});

	test("partial results emit tool_execution_update before the end", async () => {
		const host = await hostWith((pi) => {
			pi.registerTool({
				name: "stream",
				label: "s",
				description: "",
				parameters: {} as any,
				execute: async (_id: string, _a: unknown, _s: unknown, onUpdate: (p: unknown) => void) => {
					onUpdate(text("half"));
					return text("done");
				},
			} as any);
		});
		await host.callTool("stream");
		expect(trace(host).map(([type]) => type)).toEqual(["tool_execution_start", "tool_call", "tool_execution_update", "tool_result", "tool_execution_end"]);
	});
});

describe("nested ctx.executeTool", () => {
	test("a wrapper's nested bridge call carries parentToolCallId on every event; bridge answers through the pipeline", async () => {
		const bridge = new FakeBridge().respond(DELEGATE, () => ({ threadId: "t-1" }));
		const host = new FakePiHost();
		await host.load(EXT, wrapperExtension(DELEGATE));
		bridge.installOn(host);
		await host.startSession();
		expect(host.active.has(DELEGATE)).toBe(false); // deferred: not model-facing, still callable nested
		const call = await host.callTool("wrapper");
		expect(call.isError).toBe(false);
		expect(call.result.content[0].text).toBe('nested ok: {"threadId":"t-1"}');
		expect(bridge.calls).toEqual([{ name: DELEGATE, args: { task: "x" } }]);
		expect(trace(host)).toEqual([
			["tool_execution_start", "call-1", undefined],
			["tool_call", "call-1", undefined],
			["tool_execution_start", "call-1/1", "call-1"],
			["tool_call", "call-1/1", "call-1"],
			["tool_result", "call-1/1", "call-1"],
			["tool_execution_end", "call-1/1", "call-1"],
			["tool_result", "call-1", undefined],
			["tool_execution_end", "call-1", undefined],
		]);
		expect(host.toolEvents.find((e) => e.type === "tool_call" && e.toolName === DELEGATE)?.input).toEqual({ task: "x" });
	});

	test("a guard blocks the nested call: the wrapper gets an error outcome, no rejection, no bridge call", async () => {
		const bridge = new FakeBridge().respond(DELEGATE, () => ({ threadId: "t-1" }));
		const host = new FakePiHost();
		await host.load(
			EXT,
			wrapperExtension(DELEGATE, (pi) => {
				pi.on("tool_call", async (event: any) => (event.toolName === DELEGATE ? { block: true, reason: `raw from ${event.parentToolCallId}` } : undefined));
			}),
		);
		bridge.installOn(host);
		await host.startSession();
		const call = await host.callTool("wrapper");
		expect(call.result.content[0].text).toBe("nested error: raw from call-1");
		expect(bridge.calls).toEqual([]);
		expect(trace(host).filter(([, id]) => id === "call-1/1").map(([type]) => type)).toEqual(["tool_execution_start", "tool_call", "tool_execution_end"]);
	});

	test("nested ids count per caller; an unknown tool is an error outcome with start and end", async () => {
		const host = await hostWith((pi) => {
			pi.registerTool({
				name: "multi",
				label: "m",
				description: "",
				parameters: {} as any,
				async execute(_id: string, _a: unknown, _s: unknown, _u: unknown, ctx: any) {
					const first = await ctx.executeTool("missing", {});
					const second = await ctx.executeTool("missing", {});
					return text(`${first.toolCall.id} ${second.toolCall.id} ${first.isError} ${first.result.content[0].text}`);
				},
			} as any);
		});
		const call = await host.callTool("multi");
		expect(call.result.content[0].text).toBe("call-1/1 call-1/2 true Tool missing not found");
		expect(trace(host).filter(([, id]) => id === "call-1/1").map(([type]) => type)).toEqual(["tool_execution_start", "tool_execution_end"]);
	});

	test("the nested call inherits the caller's abort signal", async () => {
		const controller = new AbortController();
		let nestedRan = false;
		const host = await hostWith((pi) => {
			pi.registerTool({ name: "inner", label: "i", description: "", parameters: {} as any, exposure: "codemode", execute: async () => { nestedRan = true; return text("inner"); } } as any);
			pi.registerTool({
				name: "outer",
				label: "o",
				description: "",
				parameters: {} as any,
				async execute(_id: string, _a: unknown, _s: unknown, _u: unknown, ctx: any) {
					controller.abort();
					return (await ctx.executeTool("inner", {})).result;
				},
			} as any);
		});
		const call = await host.callTool("outer", {}, { signal: controller.signal });
		expect(nestedRan).toBe(false);
		expect(call.result).toEqual(text("Operation aborted"));
	});
});

describe("session entries", () => {
	test("appendEntry adds custom entries that ctx.sessionManager returns; a shared array models /reload", async () => {
		const host = await hostWith((pi) => {
			pi.registerTool({
				name: "save",
				label: "s",
				description: "",
				parameters: {} as any,
				async execute(_id: string, args: any, _s: unknown, _u: unknown, ctx: any) {
					(pi as any).appendEntry("fx-entry", { n: args.n });
					return text(String(ctx.sessionManager.getEntries().length));
				},
			} as any);
		});
		host.addUserMessage("go");
		expect((await host.callTool("save", { n: 1 })).result.content[0].text).toBe("2");
		const reloaded = new FakePiHost({ entries: host.entries });
		let restored: unknown[] = [];
		await reloaded.load(EXT, (pi) => {
			pi.on("session_start", async (_e: unknown, ctx: any) => {
				restored = ctx.sessionManager.getEntries();
			});
		});
		await reloaded.startSession();
		expect(restored).toMatchObject([
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "custom", customType: "fx-entry", data: { n: 1 } },
		]);
	});
});
