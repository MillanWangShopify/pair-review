// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  getDiffFileList,
  parseUnifiedDiffPatches,
  countPatchStats,
  mergeChangedFilesWithDiff
} = require('../../src/utils/diff-file-list');
const {
  LOOKALIKE_DIFF, LOOKALIKE_STATS, EXHAUSTED_HUNK_PATCH, EXHAUSTED_HUNK_STATS
} = require('../utils/diff-stat-fixtures');

describe('diff-file-list utils', () => {
  it('includes Git-quoted deleted filenames in the authoritative file list', () => {
    const diff = String.raw`diff --git "a/caf\303\251.js" "b/caf\303\251.js"
deleted file mode 100644
index 1111111..0000000
--- "a/caf\303\251.js"
+++ /dev/null
@@ -1 +0,0 @@
-removed
`;
    expect([...parseUnifiedDiffPatches(diff).keys()]).toEqual(['café.js']);
  });

  it('decodes quoted rename source paths along with the diff header', () => {
    const diff = String.raw`diff --git "a/caf\303\251.js" "b/na\303\257ve.js"
similarity index 100%
rename from "caf\303\251.js"
rename to "na\303\257ve.js"
`;
    expect(mergeChangedFilesWithDiff([], diff)).toMatchObject([
      { file: 'naïve.js', renamed: true, renamedFrom: 'café.js' }
    ]);
  });

  it('merges a Git-quoted numstat entry with its decoded diff header into one entry', () => {
    const diff = String.raw`diff --git "a/caf\303\251.js" "b/caf\303\251.js"
index 1111111..2222222 100644
--- "a/caf\303\251.js"
+++ "b/caf\303\251.js"
@@ -1 +1,2 @@
 a
+b
`;
    const changedFiles = [{ file: String.raw`"caf\303\251.js"`, insertions: 1, deletions: 0, changes: 1 }];

    const merged = mergeChangedFilesWithDiff(changedFiles, diff);

    expect(merged).toEqual([{ file: 'café.js', insertions: 1, deletions: 0, changes: 1 }]);
  });

  it('re-spells a cached quoted rename entry once the diff confirms the decoded path', () => {
    const diff = String.raw`diff --git a/lib/x.js "b/l\303\257b/x.js"
similarity index 100%
rename from lib/x.js
rename to "l\303\257b/x.js"
`;
    const merged = mergeChangedFilesWithDiff(
      [String.raw`lib/x.js => "l\303\257b/x.js"`, { file: String.raw`lib/x.js => "l\303\257b/x.js"`, changes: 0 }],
      diff
    );

    expect(merged).toEqual([
      'lïb/x.js',
      { file: 'lïb/x.js', changes: 0, renamed: true, renamedFrom: 'lib/x.js' }
    ]);
  });

  it('keeps an entry that only looks quoted when the diff does not confirm the decoded path', () => {
    const diff = String.raw`diff --git "a/\"x\"" "b/\"x\""
index 1111111..2222222 100644
`;
    const merged = mergeChangedFilesWithDiff([{ file: '"x"', changes: 1 }], diff);

    expect(merged).toEqual([{ file: '"x"', changes: 1 }]);
  });

  it('re-spells a decoded "rename" that is really a file literally named like one', () => {
    // numstat prints a file named `a => b.md` unquoted, which parses as a
    // rename of `a` to `b.md`; the diff header carries the literal name.
    const diff = [
      'diff --git a/a => b.md b/a => b.md',
      'index 1111111..2222222 100644',
      '--- a/a => b.md',
      '+++ b/a => b.md',
      '@@ -1 +1,2 @@',
      ' 1',
      '+2',
      'diff --git a/src/{a => b}.md b/src/{a => b}.md',
      'index 1111111..2222222 100644',
      '--- a/src/{a => b}.md',
      '+++ b/src/{a => b}.md',
      '@@ -1 +1,2 @@',
      ' 1',
      '+2',
      ''
    ].join('\n');
    const changedFiles = [
      { file: 'b.md', insertions: 1, deletions: 0, changes: 1, renamed: true, renamedFrom: 'a' },
      { file: 'src/b.md', insertions: 1, deletions: 0, changes: 1, renamed: true, renamedFrom: 'src/a.md' }
    ];

    expect(mergeChangedFilesWithDiff(changedFiles, diff)).toEqual([
      { file: 'a => b.md', insertions: 1, deletions: 0, changes: 1 },
      { file: 'src/{a => b}.md', insertions: 1, deletions: 0, changes: 1 }
    ]);
  });

  it('keeps a genuine arrow rename whose destination is in the diff', () => {
    const diff = [
      'diff --git a/a b/b.md',
      'similarity index 100%',
      'rename from a',
      'rename to b.md',
      ''
    ].join('\n');
    const entry = { file: 'b.md', changes: 0, renamed: true, renamedFrom: 'a' };

    expect(mergeChangedFilesWithDiff([entry], diff)).toEqual([entry]);
  });

  it('parses full file paths from unified diff headers', () => {
    const diff = [
      'diff --git a/src/short.js b/src/short.js',
      'index 1111111..2222222 100644',
      '--- a/src/short.js',
      '+++ b/src/short.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx b/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      'index 3333333..4444444 100644',
      '--- a/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      '+++ b/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      '@@ -1 +1 @@',
      '-before',
      '+after'
    ].join('\n');

    const patches = parseUnifiedDiffPatches(diff);

    expect([...patches.keys()]).toEqual([
      'src/short.js',
      'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx'
    ]);
  });

  it('counts patch additions and deletions without including file headers', () => {
    const patch = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      '+also-added'
    ].join('\n');

    expect(countPatchStats(patch)).toEqual({ insertions: 2, deletions: 1 });
  });

  it('counts content lines that legitimately begin with +++ or ---', () => {
    const patch = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,2 +1,2 @@',
      '---triple-minus-content',
      '+++triple-plus-content'
    ].join('\n');

    expect(countPatchStats(patch)).toEqual({ insertions: 1, deletions: 1 });
  });

  describe('hunk lines that look like file headers', () => {
    const patches = parseUnifiedDiffPatches(LOOKALIKE_DIFF);
    const stats = file => {
      const { insertions, deletions } = countPatchStats(patches.get(file));
      return { additions: insertions, deletions };
    };

    it('counts a removed `-- comment` (`--- x`) and an added `++ x` (`+++ x`) line', () => {
      expect(stats('q.sql')).toEqual(LOOKALIKE_STATS['q.sql']);
    });

    it('leaves real headers, `\\ No newline` markers and binary sections uncounted', () => {
      expect(stats('a.js')).toEqual(LOOKALIKE_STATS['a.js']);
      expect(stats('img.bin')).toEqual(LOOKALIKE_STATS['img.bin']);
    });

    it('stops counting once a hunk has delivered its declared lines', () => {
      const { insertions, deletions } = countPatchStats(EXHAUSTED_HUNK_PATCH);
      expect({ additions: insertions, deletions }).toEqual(EXHAUSTED_HUNK_STATS);
    });

    it('carries the counts into changed_files entries recovered from the diff', () => {
      const merged = mergeChangedFilesWithDiff([], LOOKALIKE_DIFF);
      const byFile = Object.fromEntries(merged.map(entry =>
        [entry.file, { additions: entry.insertions, deletions: entry.deletions }]));
      expect(byFile).toEqual(LOOKALIKE_STATS);
      expect(merged.find(entry => entry.file === 'q.sql').changes).toBe(4);
      expect(merged.find(entry => entry.file === 'img.bin').binary).toBe(true);
    });
  });

  it('merges missing diff files back into changed_files using full patch paths', () => {
    const longPath = 'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
    const diff = [
      `diff --git a/${longPath} b/${longPath}`,
      'index 3333333..4444444 100644',
      `--- a/${longPath}`,
      `+++ b/${longPath}`,
      '@@ -1 +1,3 @@',
      ' export const Route = {};',
      '+Route.component = View;',
      '+Route.loader = loader;'
    ].join('\n');

    const merged = mergeChangedFilesWithDiff([
      { file: 'areas/internal-services/.../$number/route.tsx', insertions: 2, deletions: 0 }
    ], diff);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      file: longPath,
      insertions: 2,
      deletions: 0,
      changes: 2
    });
  });
});

describe('getDiffFileList in Local mode (no persisted snapshot)', () => {
  let repo;

  function git(...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }
  function write(file, content) {
    fs.writeFileSync(path.join(repo, file), content);
  }
  const list = async (scopeStart, scopeEnd, extra = {}) => (await getDiffFileList(null, {
    local_path: repo, local_scope_start: scopeStart, local_scope_end: scopeEnd, ...extra
  })).sort();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-file-list-scope-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test User');
    git('config', 'commit.gpgsign', 'false');
    for (const file of ['committed.js', 'staged.js', 'unstaged.js']) write(file, 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    write('committed.js', 'branch\n');
    git('commit', '-qam', 'branch change');
    write('staged.js', 'staged\n');
    git('add', 'staged.js');
    write('unstaged.js', 'unstaged\n');
    write('untracked.js', 'new\n');
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('lists unstaged and untracked files under the default scope', async () => {
    expect(await list(null, null)).toEqual(['unstaged.js', 'untracked.js']);
  });

  it('includes staged files when the review scope starts at staged', async () => {
    expect(await list('staged', 'untracked')).toEqual(['staged.js', 'unstaged.js', 'untracked.js']);
    expect(await list('staged', 'unstaged')).toEqual(['staged.js', 'unstaged.js']);
  });

  it('includes branch commits against the review base branch', async () => {
    expect(await list('branch', 'untracked', { local_base_branch: 'main' }))
      .toEqual(['committed.js', 'staged.js', 'unstaged.js', 'untracked.js']);
  });

  it('returns an empty list when git cannot read the repository', async () => {
    expect(await getDiffFileList(null, { local_path: path.join(repo, 'missing-dir') })).toEqual([]);
  });
});
