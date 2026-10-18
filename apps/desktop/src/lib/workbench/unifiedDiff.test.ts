import { describe, expect, test } from 'bun:test';
import { parseUnifiedDiff } from './unifiedDiff';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ fn
 one
-two
+TWO
 three
diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
\\ kingu: diff truncated
`;

describe('parseUnifiedDiff', () => {
	const { files, truncated } = parseUnifiedDiff(DIFF);
	test('files and their kinds', () => {
		expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
			['src/a.ts', 'modified', false],
			['new.txt', 'renamed', false],
			['img.png', 'added', true],
			['gone.txt', 'deleted', false]
		]);
		expect(files[1].oldPath).toBe('old.txt');
		expect(truncated).toBe(true);
	});
	test('hunk lines are numbered on both sides', () => {
		expect(files[0].hunks[0].lines).toEqual([
			{ kind: 'ctx', text: 'one', old: 1, new: 1 },
			{ kind: 'del', text: 'two', old: 2, new: null },
			{ kind: 'add', text: 'TWO', old: null, new: 2 },
			{ kind: 'ctx', text: 'three', old: 3, new: 3 }
		]);
		expect([files[0].added, files[0].deleted, files[3].deleted]).toEqual([1, 1, 1]);
	});
});
