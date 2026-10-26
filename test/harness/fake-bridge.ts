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
				this.calls.push({ name, args });
				const responder = this.responders.get(name);
				if (!responder) throw new Error(`Tool ${name} not found`);
				const data: any = await responder(args);
				if (data && typeof data === "object" && "__mcpError" in data) {
					const content = [{ type: "text", text: data.__mcpError }];
					return { isError: false, result: { content, structuredContent: { isError: true, content } } };
				}
				const content = [{ type: "text", text: JSON.stringify(data) }];
				return { isError: false, result: { content, structuredContent: { content, structuredContent: data } } };
			},
			...extra,
		};
	}
}
