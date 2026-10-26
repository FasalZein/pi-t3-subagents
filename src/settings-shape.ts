/**
 * T3 settings shape (compatibility contract C6). T3 keeps unknown keys inside
 * an instance's `config`; `environment` is an array of
 * `{ name, value, sensitive? }` entries.
 */
export const MANAGED_BY = "pi-t3-subagents";

export interface EnvironmentEntry {
	readonly name: string;
	readonly value: string;
	readonly sensitive: false;
}

export interface ProviderInstanceEntry {
	driver: string;
	displayName?: string;
	enabled?: boolean;
	environment?: EnvironmentEntry[];
	config?: Record<string, unknown>;
	[key: string]: unknown;
}

export type Settings = Record<string, unknown> & { providerInstances?: Record<string, ProviderInstanceEntry> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Returns a list of shape problems. An empty list means the file has the shape
 * the sync relies on (C6); otherwise the sync refuses to write.
 */
export function settingsShapeProblems(value: unknown): string[] {
	if (!isObject(value)) return ["settings.json is not a JSON object"];
	const instances = value.providerInstances;
	if (instances === undefined) return [];
	if (!isObject(instances)) return ["providerInstances is not an object"];
	const problems: string[] = [];
	for (const [id, entry] of Object.entries(instances)) {
		if (!isObject(entry)) {
			problems.push(`providerInstances.${id} is not an object`);
			continue;
		}
		if (typeof entry.driver !== "string") problems.push(`providerInstances.${id}.driver is not a string`);
		if (entry.config !== undefined && !isObject(entry.config)) problems.push(`providerInstances.${id}.config is not an object`);
		if (entry.environment !== undefined) {
			if (!Array.isArray(entry.environment)) problems.push(`providerInstances.${id}.environment is not an array`);
			else if (entry.environment.some((e) => !isObject(e) || typeof e.name !== "string"))
				problems.push(`providerInstances.${id}.environment has an entry without a name`);
		}
	}
	return problems;
}

export function isOwnedBy(entry: ProviderInstanceEntry | undefined, namespace: string): boolean {
	return entry?.config?.managedBy === MANAGED_BY && entry?.config?.namespace === namespace;
}

/** Structural JSON equality (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value))
		return `{${Object.keys(value)
			.filter((k) => value[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
