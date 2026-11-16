// The Clean Up Tasks dialog's filters and sort (Orca persists them per dialog): kept in this
// browser profile's localStorage, repaired field by field when read, so one bad value never resets
// the rest. localStorage can be unavailable or throw, so every access is guarded.
import { createDefaultWorkspaceCleanupBrowseState, normalizeWorkspaceCleanupBrowseState, type WorkspaceCleanupBrowseState, type WorkspaceCleanupFilterState, type WorkspaceCleanupSortState } from './workspaceCleanupFilters';

const KEY = 'kingu.cleanup.browse';

function load(): WorkspaceCleanupBrowseState {
	try {
		const raw = localStorage.getItem(KEY);
		return normalizeWorkspaceCleanupBrowseState(raw ? JSON.parse(raw) : null);
	} catch {
		return createDefaultWorkspaceCleanupBrowseState();
	}
}

class CleanupBrowse {
	state = $state<WorkspaceCleanupBrowseState>(load());

	get filters(): WorkspaceCleanupFilterState {
		return this.state.filters;
	}
	get sort(): WorkspaceCleanupSortState {
		return this.state.sort;
	}

	setFilters(filters: WorkspaceCleanupFilterState) {
		this.state = { ...this.state, filters };
		this.#save();
	}

	setSort(sort: WorkspaceCleanupSortState) {
		this.state = { ...this.state, sort };
		this.#save();
	}

	clear() {
		this.setFilters(createDefaultWorkspaceCleanupBrowseState().filters);
	}

	#save() {
		try {
			localStorage.setItem(KEY, JSON.stringify($state.snapshot(this.state)));
		} catch {
			// Not saved: the filters still apply to this dialog.
		}
	}
}

export const cleanupBrowse = new CleanupBrowse();
