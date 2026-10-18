// Monaco's configuration service (VS Code's IConfigurationService in the standalone editor). The
// editor contributions read some settings from it rather than from the editor's options
// (`editor.codeActionWidget.showHeaders`, `editor.stickyScroll.enabled`, `editor.maxTokenizationLineLength`,
// `editor.largeFileOptimizations`, the model defaults such as `editor.tabSize`, …), so Kingu writes
// every editor.* and diffEditor.* setting into it, like VS Code's own configuration does.
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { IConfigurationService } from 'monaco-editor/platform/configuration/common/configuration.js';

type ConfigurationService = { updateValues?(values: [string, unknown][]): Promise<void> };

/** Writes `[key, value]` pairs into Monaco's configuration (unchanged values are skipped by Monaco). */
export function updateMonacoConfiguration(values: [string, unknown][]) {
	const service = StandaloneServices.get(IConfigurationService) as ConfigurationService;
	void service.updateValues?.(values);
}
