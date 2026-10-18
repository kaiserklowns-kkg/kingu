// Every VS Code setting Kingu adds beyond the ones in ideSettings.ts / registry.ts, by area.
import { EDITOR_SETTINGS } from './editor';
import { DIFF_EDITOR_SETTINGS } from './diffEditor';
import { WORKBENCH_SETTINGS } from './workbench';
import { EDITOR_MANAGEMENT_SETTINGS } from './editorManagement';
import { WINDOW_SETTINGS } from './window';
import { FILES_SETTINGS } from './files';
import { EXPLORER_SETTINGS } from './explorer';
import { SEARCH_SETTINGS } from './search';
import { TERMINAL_SETTINGS } from './terminal';
import { GIT_SETTINGS } from './scmGit';
import { SCM_SETTINGS } from './scm';
import { DEBUG_SETTINGS } from './debug';
import { BREADCRUMBS_SETTINGS } from './breadcrumbs';
import { PROBLEMS_SETTINGS } from './problems';
import { APPLICATION_SETTINGS } from './application';

export const VSCODE_SETTINGS = [
	...EDITOR_SETTINGS,
	...DIFF_EDITOR_SETTINGS,
	...WORKBENCH_SETTINGS,
	...EDITOR_MANAGEMENT_SETTINGS,
	...WINDOW_SETTINGS,
	...FILES_SETTINGS,
	...EXPLORER_SETTINGS,
	...SEARCH_SETTINGS,
	...TERMINAL_SETTINGS,
	...GIT_SETTINGS,
	...SCM_SETTINGS,
	...DEBUG_SETTINGS,
	...BREADCRUMBS_SETTINGS,
	...PROBLEMS_SETTINGS,
	...APPLICATION_SETTINGS,
];
