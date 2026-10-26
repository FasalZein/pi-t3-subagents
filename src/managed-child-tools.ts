/**
 * Managed-child tool installation (integration seam for S5-S8; review "Shared-file
 * corrections" item 3).
 *
 * A tool that only a managed child has (for example S6 `caller_ping`) is registered while
 * the extension loads. Two copies of this extension can load in one runtime (contract C2);
 * a tool name registered twice while loading stops Pi 1.4.0. So only the copy that owns the
 * takeover runs the installers, and only in a managed child (PI_T3_AGENT set). The copy
 * registry resets at `session_shutdown`, so after /reload the first copy loaded owns again.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntime } from "./child-runtime.ts";
import type { Takeover } from "./takeover.ts";

/** Registers one slice's managed-child tools and handlers. Runs once, while loading. */
export type ManagedChildToolInstaller = (pi: ExtensionAPI, child: ChildRuntime) => void;

/** True when this copy installs managed-child tools: a managed child, and this copy owns the takeover. */
export function ownsManagedChildTools(child: ChildRuntime | undefined, takeover: Takeover): child is ChildRuntime {
	return child !== undefined && takeover.state().kind !== "second_copy";
}

/** Run `installers` in order when this copy owns managed-child tools; return whether they ran. */
export function installManagedChildTools(
	pi: ExtensionAPI,
	child: ChildRuntime | undefined,
	takeover: Takeover,
	installers: readonly ManagedChildToolInstaller[],
): boolean {
	if (!ownsManagedChildTools(child, takeover)) return false;
	for (const install of installers) install(pi, child);
	return true;
}
