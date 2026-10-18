# i18n — Thai and English UI

No dependency: `t(key, params?)` looks the key up in the catalog of the current UI language.

- Language: setting `kingu.uiLanguage` = `auto` | `th` | `en` (default `auto`: Thai when the
  OS / WebView language starts with `th`, else English). Changing it applies right away.
- Catalogs: `en/<area>.ts` is the source of keys, `th/<area>.ts` is typed
  `satisfies Record<keyof typeof en, string>`, so a missing Thai message fails `bun run check`
  (CI). `i18n.test.ts` checks both catalogs have the same keys, the same `{params}` per key and
  no empty messages.
- Not translated: command palette titles and categories (English, like VS Code), settings
  descriptions (Thai then English, in the registry), Rust error text (Thai for now).

## Using it in a component

```svelte
<script lang="ts">
	import { t } from '#lib/i18n/index.ts';
	let { count, name } = $props();
</script>

<button title={t('ade.tasks.newTask')}>{t('common.cancel')}</button>
<p>{t('ade.tasks.filesChanged', { count })}</p>
```

`t()` reads the reactive locale, so calls in markup, `$derived` and `$effect` update when the
language changes. Don't cache a translated string in a plain variable at module or script top
level — call `t()` where it's shown (or in a `$derived`).

## Adding a string

1. Add the key to `en/<area>.ts` (pick the area of the code; keys are `area.file.what`, e.g.
   `ade.tasks.removeFailed`). Shared button words live in `en/common.ts` (`common.cancel`, …).
2. Add the Thai message under the same key in `th/<area>.ts`. `bun run check` tells you if you
   forgot.
3. Components get a new area pair (`en/<area>.ts` + `th/<area>.ts`), spread into `en.ts` and
   `th.ts`. One file per area keeps parallel work from colliding.

## Message syntax

- `{name}` — a param: `t('ade.tasks.removed', { slug })`. `t()` is typed: it asks for exactly
  the params the English message uses.
- `{count|one|other}` — plural: `one` when count is 1, else `other`; `#` is the number.
  English `'{count|# file|# files} changed'`, Thai `'เปลี่ยน {count} ไฟล์'`.
- Error text from Rust or the OS goes in as a param (`'Could not delete: {error}'`).

Thai style: plain and short like the rest of the UI, no ครับ/ค่ะ; keep technical words people
type (worktree, branch, commit, agent) in English.

## Tests

The default language outside the app is English (`navigator.language` is unset in bun). A test
that checks Thai text calls `setLocale('th')` and resets with `setLocale('en')` afterwards.
