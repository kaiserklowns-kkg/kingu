// Monaco's configuration service (VS Code's IConfigurationService in the standalone editor). The
// editor contributions read some settings from it rather than from the editor's options
// (`editor.codeActionWidget.showHeaders`, `editor.stickyScroll.enabled`, `editor.maxTokenizationLineLength`,
// `editor.largeFileOptimizations`, the model defaults such as `editor.tabSize`, …), so Kingu writes
// every editor.* and diffEditor.* setting into it, like VS Code's own configuration does.
//
// The first `StandaloneServices.get` creates Monaco's service collection from the services
// registered so far. Asked before the full editor (`monaco.ts`, which loads every contribution)
// has run, it would leave the suggest widget, code actions, code lens and others without their
// services ("depends on UNKNOWN service"). So values wait here until `monaco.ts` says it is in.
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from 'monaco-editor/platform/configuration/common/configuration.js';

type ConfigurationService = { updateValues?(values: [string, unknown][]): Promise<void> };

let ready = false;
const pending = new Map<string, unknown>();

function write(values: [string, unknown][]) {
	const service = StandaloneServices.get(IConfigurationService) as ConfigurationService;
	void service.updateValues?.(values);
}

/** Writes `[key, value]` pairs into Monaco's configuration (unchanged values are skipped by Monaco);
 * before the editor has loaded, the latest value per key is kept for then. */
export function updateMonacoConfiguration(values: [string, unknown][]) {
	if (ready) return write(values);
	for (const [k, v] of values) pending.set(k, v);
}

/** Called once by `monaco.ts` after every editor contribution has registered its services. */
export function monacoLoaded() {
	if (ready) return;
	ready = true;
	if (pending.size) write([...pending]);
	pending.clear();
}
