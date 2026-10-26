/**
 * Layer 1 seam: a fake T3 bridge behind ctx.executeTool.
 *
 * Records every call and answers with T3-shaped results. Shape (spike round 2, T3 Pi
 * bridge): the outcome's `result.structuredContent` is the MCP result without `_meta`, so
 * the tool data sits at `result.structuredContent.structuredContent`.
 */
export interface BridgeCall {
	name: string;
	args: any;
}

type Responder = (args: any) => unknown;

/** Where the fake bridge's tools come from when installed on a FakePiHost. */
export const BRIDGE_PATH = "/t3/pi-mcp-bridge/index.ts";

/** The FakePiHost surface the bridge needs (kept structural to avoid an import cycle). */
interface ToolHost {
	addTool(name: string, path: string, exposure?: "direct" | "codemode" | "deferred", active?: boolean, execute?: (toolCallId: string, args: any) => unknown): void;
}

export class FakeBridge {
	readonly calls: BridgeCall[] = [];
	private readonly responders = new Map<string, Responder>();

	/** Answer `name` with MCP tool data `structuredContent` (or throw from the responder). */
	respond(name: string, responder: Responder): this {
		this.responders.set(name, responder);
		return this;
	}

	/** Answer `name` with an MCP error result carrying `text`. */
	fail(name: string, text: string): this {
		this.responders.set(name, () => ({ __mcpError: text }));
		return this;
	}

	/** Tool context for execute(): `tools` lists the callable bridge tools. */
	toolContext(extra: Record<string, unknown> = {}): any {
		return {
			hasUI: false,
			cwd: "/tmp",
			tools: [...this.responders.keys()].map((name) => ({ name })),
			executeTool: async (name: string, args: unknown) => {
				if (!this.responders.has(name)) {
					this.calls.push({ name, args });
					throw new Error(`Tool ${name} not found`);
				}
				return { isError: false, result: await this.answer(name, args) };
			},
			...extra,
		};
	}

	/**
	 * Register every answered tool on a FakePiHost (deferred, as the T3 bridge exposes its
	 * tools), so a ctx.executeTool call goes through the host's tool pipeline: `tool_call`
	 * guards, `tool_result` and execution events with `parentToolCallId`. Call after respond().
	 */
	installOn(host: ToolHost, exposure: "direct" | "codemode" | "deferred" = "deferred"): this {
		for (const name of this.responders.keys()) host.addTool(name, BRIDGE_PATH, exposure, false, (_id, args) => this.answer(name, args));
		return this;
	}

	private async answer(name: string, args: unknown): Promise<any> {
		this.calls.push({ name, args });
		const data: any = await this.responders.get(name)?.(args);
		if (data && typeof data === "object" && "__mcpError" in data) {
			const content = [{ type: "text", text: data.__mcpError }];
			return { content, structuredContent: { isError: true, content } };
		}
		const content = [{ type: "text", text: JSON.stringify(data) }];
		return { content, structuredContent: { content, structuredContent: data } };
	}
}
