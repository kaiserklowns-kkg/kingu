// Which formatter runs when a document has several (VS Code's DefaultFormatter contribution):
// Monaco asks FormattingConflicts' selector, which follows editor.defaultFormatter (per language,
// `"[typescript]": { "editor.defaultFormatter": … }`). With none configured and several to choose
// from, a user action asks to configure one and a silent format (on save) shows a notification.
// Also Format Document With… (`editor.action.formatDocument.multiple`).

import type * as Monaco from 'monaco-editor';
import { FormattingConflicts, getRealAndSyntheticDocumentFormattersOrdered } from 'monaco-editor/editor/contrib/format/browser/format.js';
import { ILanguageFeaturesService } from 'monaco-editor/editor/common/services/languageFeatures.js';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { chooseFormatter, formatterCandidates, formatterName, formatterSettingValue, matchesFormatterId, type FormatterLike } from './formatters';

const EXPLICIT = 1;

/** Set while Format Document With… runs the formatter the user picked. */
let forced: FormatterLike | null = null;

let monacoApi: typeof Monaco | undefined;

const languageName = (languageId: string) => monacoApi?.languages.getLanguages().find((l) => l.id === languageId)?.aliases?.[0] ?? languageId;

/** Configure Default Formatter: pick one of `list`, written as `"[language]": { "editor.defaultFormatter" }` in the user settings. */
async function pickDefault<T extends FormatterLike>(list: readonly T[], languageId: string): Promise<T | undefined> {
	const candidates = formatterCandidates(list);
	const pick = await quick.choose({
		placeholder: t('editing.formatter.selectDefault', { language: languageName(languageId) }),
		items: candidates.map((f, i) => ({ id: String(i), label: formatterName(f), description: formatterSettingValue(f, languageId) }))
	});
	const chosen = pick ? candidates[Number(pick.id)] : undefined;
	if (!chosen) return undefined;
	const key = `[${languageId}]`;
	const block = settings.inspect(key, 'user');
	const next = { ...(block && typeof block === 'object' && !Array.isArray(block) ? block : {}), 'editor.defaultFormatter': formatterSettingValue(chosen, languageId) };
	await settings.set(key, next, 'user').catch((e) => notifications.error(String(e)));
	return chosen;
}

async function select<T extends FormatterLike>(formatters: T[], model: Monaco.editor.ITextModel, mode: number): Promise<T | undefined> {
	if (forced) return formatters.find((f) => f === forced) ?? formatters.find((f) => formatterName(f) === formatterName(forced!));
	const languageId = model.getLanguageId();
	const defaultId = settings.getFor<string | null>('editor.defaultFormatter', languageId);
	const choice = chooseFormatter(formatters, defaultId);
	if ('formatter' in choice) return choice.formatter;
	const message =
		choice.problem === 'multiple'
			? t('editing.formatter.multiple', { language: languageName(languageId) })
			: t('editing.formatter.unavailable', { formatter: defaultId ?? '', language: languageName(languageId) });
	const configure = t('editing.formatter.configure');
	if (mode === EXPLICIT) {
		if (await ask(message, { title: t('editing.formatter.configureTitle'), okLabel: configure })) return pickDefault(formatters, languageId);
		return undefined;
	}
	// Format on save: say so and go on without formatting.
	void notifications.prompt('info', message, [configure]).then((c) => c === configure && void pickDefault(formatters, languageId));
	return undefined;
}

/** The document formatters of `model` (each language server's, Monaco's built-in ones). */
function formattersOf(model: Monaco.editor.ITextModel): Monaco.languages.DocumentFormattingEditProvider[] {
	const features = StandaloneServices.get<{ documentFormattingEditProvider: unknown; documentRangeFormattingEditProvider: unknown }>(ILanguageFeaturesService);
	return getRealAndSyntheticDocumentFormattersOrdered(features.documentFormattingEditProvider, features.documentRangeFormattingEditProvider, model);
}

/** Format Document With…: every formatter of the focused editor's document, then Configure Default Formatter…. */
async function formatWith() {
	const editor = monacoApi?.editor.getEditors().find((e) => e.hasTextFocus()) ?? monacoApi?.editor.getEditors().find((e) => e.hasWidgetFocus());
	const model = editor?.getModel();
	if (!editor || !model || editor.getOption(monacoApi!.editor.EditorOption.readOnly)) return;
	const list = formatterCandidates(formattersOf(model));
	if (!list.length) return notifications.info(t('editing.formatter.none', { language: languageName(model.getLanguageId()) }));
	const languageId = model.getLanguageId();
	const defaultId = settings.getFor<string | null>('editor.defaultFormatter', languageId);
	const CONFIGURE = '\0configure';
	const pick = await quick.choose({
		placeholder: t('editing.formatter.formatWithPlaceholder'),
		items: [
			...list.map((f, i) => ({ id: String(i), label: formatterName(f), description: defaultId && matchesFormatterId(f, defaultId) ? t('editing.formatter.default') : undefined })),
			{ id: CONFIGURE, label: t('editing.formatter.configureDefault') }
		]
	});
	if (!pick) return;
	const chosen = pick.id === CONFIGURE ? await pickDefault(list, languageId) : list[Number(pick.id)];
	if (!chosen) return;
	forced = chosen;
	try {
		editor.focus();
		await editor.getAction('editor.action.formatDocument')?.run();
	} finally {
		forced = null;
	}
}

let installed = false;

/** Call once Monaco is loaded. Returns nothing: the selector and the command last for the window. */
export function installFormatterSelector(monaco: typeof Monaco) {
	if (installed) return;
	installed = true;
	monacoApi = monaco;
	FormattingConflicts.setFormatterSelector((formatters, model, mode) => select(formatters, model, mode));
	commands.register({ id: 'editor.action.formatDocument.multiple', title: 'Format Document With...', run: formatWith });
}
