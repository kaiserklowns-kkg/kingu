import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { sveltePhosphorOptimize } from 'phosphor-svelte/vite';

export default defineConfig({
	// Tauri expects a fixed port and fails if it is taken
	// `snaps/` holds the built-in snaps' files (themes...), imported raw by snapFiles.ts; outside
	// SvelteKit's allowed folders, the dev server would refuse them.
	server: { port: 1420, strictPort: true, fs: { allow: ['snaps'] } },
	clearScreen: false,
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: 'index.html' })
		}),
		// Runs after the Svelte compiler: rewrites `import { XIcon } from 'phosphor-svelte'` to per-icon imports
		sveltePhosphorOptimize()
	]
});
