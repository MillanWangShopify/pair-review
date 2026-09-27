// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

const Analyzer = require('../../src/ai/analyzer');
const { CommentRepository, ReviewRepository } = require('../../src/database');
const {
  filterSuggestionPaths, seedContextFilesForSuggestions, storeReviewSuggestions, getSuggestionDiffFiles
} = require('../../src/utils/suggestion-storage');
const ws = require('../../src/ws');
const logger = require('../../src/utils/logger');

const finding = (overrides = {}) => ({
  file: 'unchanged.js', line_start: 30, line_end: 35, old_or_new: 'OLD',
  type: 'bug', title: 'Cross-file problem', description: 'The caller breaks this behavior.',
  confidence: 0.9, level: 3, voice_id: 'reviewer-1', is_raw: 1, ...overrides
});

describe('path validation without metadata', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once and preserves normalized safe paths and their supplied side', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const input = [finding({ file: './old.js => new.js' }), finding({ file: 'other.js', old_or_new: 'NEW' })];
    expect(filterSuggestionPaths(input, [], null)).toEqual([
      finding({ file: 'new.js' }), finding({ file: 'other.js', old_or_new: 'NEW' })
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[FAILSAFE] Path validation bypassed'));
  });

  it('still drops unsafe paths when metadata is unavailable', () => {
    expect(filterSuggestionPaths(['', '/absolute.js', '../escape.js', ' ../escape.js', 'C:\\absolute.js'].map(file => finding({ file })), [], null)).toEqual([]);
  });

  it('does not bypass validation when a changed-file list is available', () => {
    expect(filterSuggestionPaths([finding()], ['changed.js'], null)).toEqual([]);
  });

  it('keeps OLD side when the changed-file list uses Git rename spelling', () => {
    const input = finding({ file: 'src/new.js' });
    expect(filterSuggestionPaths([input], ['src/{old.js => new.js}'], null)).toEqual([input]);
  });
});

describe.each(['pr', 'local'])('Suggestion save context in %s mode', mode => {
  let db, root, repoRoot, reviewId, analyzer, broadcast;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestion-storage-'));
    repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'unchanged.js'), 'code\n'.repeat(800));
    fs.writeFileSync(path.join(root, 'outside.js'), 'outside\n');
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(repoRoot, 'escape.js'));
    db = createTestDatabase();
    if (mode === 'pr') {
      reviewId = seedTestReview(db);
      db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
        VALUES ('worktree', 1, 'test/repo', 'feature', ?, '2026-01-01', '2026-01-01')`).run(repoRoot);
    } else {
      reviewId = Number(db.prepare(`INSERT INTO reviews (review_type, local_path, local_head_sha, status, repository)
        VALUES ('local', ?, 'head', 'draft', 'test/repo')`).run(repoRoot).lastInsertRowid);
    }
    analyzer = new Analyzer(db, 'sonnet', 'claude');
    broadcast = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rows = db => db.prepare('SELECT * FROM context_files').all();
  const comments = db => db.prepare('SELECT * FROM comments ORDER BY id').all();

  it('stores final unchanged paths on RIGHT and seeds only one window', async () => {
    const save = suggestions => analyzer.storeSuggestions(reviewId, 'run', suggestions, null, ['changed.js']);
    const suggestions = [finding(), finding({ line_start: 700, line_end: 705 }),
      finding({ file: 'missing.js' }), finding({ file: 'escape.js' }),
      finding({ file: '../outside.js' }), finding({ file: path.join(root, 'outside.js') })];

    await save(suggestions);
    expect(comments(db)).toHaveLength(2);
    expect(comments(db)[0]).toMatchObject({ file: 'unchanged.js', side: 'RIGHT', line_start: 30, line_end: 35 });
    expect(comments(db)[1]).toMatchObject({ side: 'RIGHT', line_start: 700, line_end: 705 });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ line_start: 20, line_end: 45, label: 'Auto-added for suggestion' });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(`review:${reviewId}`, {
      type: 'review:context_files_changed', reviewId
    });

    await save(suggestions);
    expect(rows(db)).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('retains unchanged findings through the upstream and finalization path checks', async () => {
    const input = [finding(), finding({ file: 'missing.js' })];
    const early = analyzer.validateSuggestionFilePaths(input, ['changed.js'], repoRoot);
    const finalized = await analyzer.validateAndFinalizeSuggestions(early, new Map(), ['changed.js'], repoRoot);
    expect(finalized).toEqual([finding({ old_or_new: 'NEW' })]);
    expect(input[0].old_or_new).toBe('OLD');
  });

  it('does not seed intermediate levels, raw council findings, or child runs', async () => {
    db.prepare('INSERT INTO analysis_runs (id, review_id, parent_run_id) VALUES (?, ?, ?)')
      .run('child', reviewId, 'parent');
    for (const level of [1, 2, 3]) {
      await analyzer.storeSuggestions(reviewId, 'parent', [finding()], level, ['changed.js']);
    }
    await analyzer._storeCouncilSuggestions(reviewId, 'parent', [finding()], ['changed.js']);
    await analyzer.storeSuggestions(reviewId, 'child', [finding()], null, ['changed.js']);
    expect(comments(db)).toHaveLength(5);
    expect(comments(db)[3]).toMatchObject({ voice_id: 'reviewer-1', is_raw: 1, ai_level: 3 });
    expect(rows(db)).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();

    // Final consolidation rejected the raw finding, so it never adds a wrapper.
    await analyzer.storeSuggestions(reviewId, 'parent', [], null, ['changed.js']);
    expect(rows(db)).toEqual([]);
  });

  it('can seed displayed child findings explicitly and deduplicates repeat selection', async () => {
    const patch = 'diff --git a/changed.js b/changed.js\n--- a/changed.js\n+++ b/changed.js\n';
    if (mode === 'pr') {
      db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
        .run(1, 'test/repo', JSON.stringify({ diff: patch }));
    } else {
      db.prepare('INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)').run(reviewId, patch);
    }
    expect(await seedContextFilesForSuggestions(db, reviewId, [finding()])).toBe(true);
    expect(await seedContextFilesForSuggestions(db, reviewId, [finding()])).toBe(false);
    expect(rows(db)).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('uses the authoritative patch when the caller supplies an empty changed-file list', async () => {
    const patch = 'diff --git a/deleted.js b/deleted.js\ndeleted file mode 100644\n--- a/deleted.js\n+++ /dev/null\n';
    if (mode === 'pr') {
      db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
        .run(1, 'test/repo', JSON.stringify({ changed_files: [], diff: patch }));
    } else {
      db.prepare('INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)').run(reviewId, patch);
    }
    await analyzer.storeSuggestions(reviewId, 'run', [finding({ file: 'deleted.js' })], null, []);
    expect(comments(db)[0]).toMatchObject({ file: 'deleted.js', side: 'LEFT' });
    expect(rows(db)).toEqual([]);
  });

  it('preserves OLD/deleted findings with a real root but unknown empty diff and creates no context', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding(), finding({ file: 'deleted.js' })], null, []);
    expect(comments(db)).toMatchObject([
      { file: 'unchanged.js', side: 'LEFT' }, { file: 'deleted.js', side: 'LEFT' }
    ]);
    expect(rows(db)).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('converts an invalid unchanged-file line to file-level and seeds a safe context window', async () => {
    const invalid = finding({ line_start: 900, line_end: 910 });
    expect(await analyzer.validateAndFinalizeSuggestions([invalid], new Map(), ['changed.js'], repoRoot))
      .toEqual([{ ...invalid, old_or_new: 'NEW', line_start: null, line_end: null, is_file_level: true }]);
    await analyzer.storeSuggestions(reviewId, 'run', [invalid], null, ['changed.js']);
    expect(comments(db)).toMatchObject([{ file: 'unchanged.js', line_start: null, is_file_level: 1 }]);
    expect(rows(db)).toMatchObject([{ file: 'unchanged.js', line_start: 1, line_end: 50 }]);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('converts invalid OLD coordinates while retaining valid OLD lines beyond HEAD', async () => {
    const badStart = finding({ file: 'changed.js', line_start: 0, line_end: 0 });
    const badRange = finding({ file: 'changed.js', line_start: 10, line_end: 5 });
    const validOld = finding({ file: 'changed.js', line_start: 900, line_end: 910 });
    const result = await analyzer.validateAndFinalizeSuggestions(
      [badStart, badRange, validOld], new Map([['changed.js', 10]]), ['changed.js'], repoRoot
    );
    expect(result).toEqual([
      validOld,
      { ...badStart, line_start: null, line_end: null, is_file_level: true },
      { ...badRange, line_start: null, line_end: null, is_file_level: true }
    ]);
  });

  it('recognizes a renamed changed-file entry without seeding context', async () => {
    const renamed = finding({ file: 'src/new.js', line_start: 10, line_end: 10 });
    await analyzer.storeSuggestions(reviewId, 'run', [renamed], null, ['src/{old.js => new.js}']);
    expect(comments(db)).toMatchObject([{ file: 'src/new.js', side: 'LEFT' }]);
    expect(rows(db)).toEqual([]);
  });

  if (mode === 'pr') {
    it('does not resolve the checkout again when storing and seeding prepared findings', async () => {
      db.prepare('DELETE FROM worktrees').run();
      db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
        .run(1, 'test/repo', JSON.stringify({ worktree_path: repoRoot }));
      const stat = vi.spyOn(fs.promises, 'stat');
      try {
        const preparedSuggestions = [finding({ old_or_new: 'NEW' })];
        await storeReviewSuggestions(db, {
          reviewId, runId: 'run', suggestions: preparedSuggestions, preparedSuggestions,
          changedFiles: ['changed.js']
        });
        expect(comments(db)).toHaveLength(1);
        expect(rows(db)).toHaveLength(1);
        expect(stat).not.toHaveBeenCalled();
      } finally {
        stat.mockRestore();
      }
    });

    it('stores unchanged findings from --use-checkout using PR metadata alone', async () => {
      db.prepare('DELETE FROM worktrees').run();
      db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
        .run(1, 'test/repo', JSON.stringify({ worktree_path: repoRoot, changed_files: ['changed.js'] }));
      await analyzer.storeSuggestions(reviewId, 'run', [finding()], null, ['changed.js']);
      expect(comments(db)).toHaveLength(1);
      expect(comments(db)[0]).toMatchObject({ file: 'unchanged.js', side: 'RIGHT' });
      expect(rows(db)).toHaveLength(1);
    });
  }

  it('keeps LEFT-side changed/deleted paths without requiring a file on disk', async () => {
    await analyzer.storeSuggestions(reviewId, 'run', [finding({ file: './old.js => changed.js' })], 1, ['changed.js']);
    expect(comments(db)[0]).toMatchObject({ file: 'changed.js', side: 'LEFT' });
    expect(rows(db)).toHaveLength(0);
  });

  it('preserves OLD coordinates beyond the shortened checkout while still validating NEW coordinates', async () => {
    fs.writeFileSync(path.join(repoRoot, 'changed.js'), 'remaining line\n'.repeat(10));
    const oldFinding = finding({ file: 'changed.js', line_start: 100, line_end: 105 });
    const newFinding = { ...oldFinding, old_or_new: 'NEW' };
    const finalized = await analyzer.validateAndFinalizeSuggestions(
      [oldFinding, newFinding], new Map([['changed.js', 10]]), ['changed.js'], repoRoot
    );
    expect(finalized).toEqual([
      oldFinding, { ...newFinding, line_start: null, line_end: null, is_file_level: true }
    ]);

    await analyzer.storeSuggestions(reviewId, 'run', [oldFinding, newFinding], null, ['changed.js']);
    expect(comments(db)).toMatchObject([
      { file: 'changed.js', side: 'LEFT', line_start: 100, line_end: 105, is_file_level: 0 },
      { file: 'changed.js', side: 'RIGHT', line_start: null, line_end: null, is_file_level: 1 }
    ]);
    expect(rows(db)).toEqual([]);
  });

  it('preserves displayed LEFT findings when their coordinates exceed current file length', async () => {
    fs.writeFileSync(path.join(repoRoot, 'changed.js'), 'remaining line\n'.repeat(10));
    const displayed = finding({ file: 'changed.js', old_or_new: undefined, side: 'LEFT', line_start: 100, line_end: 105 });
    expect(await analyzer.validateAndFinalizeSuggestions(
      [displayed], new Map([['changed.js', 10]]), ['changed.js'], repoRoot
    )).toEqual([displayed]);
  });

  it('does not create a stray context row when insertion fails', async () => {
    vi.spyOn(CommentRepository.prototype, 'bulkInsertAISuggestions').mockRejectedValue(new Error('insert failed'));
    await expect(analyzer.storeSuggestions(reviewId, 'run', [finding()], 3, ['changed.js'])).rejects.toThrow('insert failed');
    expect(rows(db)).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('deduplicates context files when two voices store concurrently', async () => {
    await Promise.all([
      analyzer.storeSuggestions(reviewId, 'voice-a', [finding()], null, ['changed.js']),
      analyzer.storeSuggestions(reviewId, 'voice-b', [finding()], null, ['changed.js'])
    ]);
    expect(comments(db)).toHaveLength(2);
    expect(rows(db)).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('handles file-level findings and the legacy single line field', async () => {
    await storeReviewSuggestions(db, {
      reviewId, runId: 'run', changedFiles: ['changed.js'],
      suggestions: [finding({ line_start: undefined, line_end: undefined, line: 25 })]
    });
    expect(rows(db)[0]).toMatchObject({ line_start: 15, line_end: 35 });
    db.prepare('DELETE FROM context_files').run();
    await storeReviewSuggestions(db, {
      reviewId, runId: 'run', changedFiles: ['changed.js'],
      suggestions: [finding({ line_start: null, line_end: null, is_file_level: true })]
    });
    expect(rows(db)[0]).toMatchObject({ line_start: 1, line_end: 50 });
  });

  it('handles null suggestions and rejects malformed paths or directories', () => {
    expect(filterSuggestionPaths(null, null, repoRoot)).toEqual([]);
    expect(filterSuggestionPaths([null, finding({ file: {} }), finding({ file: '.' }), finding({ file: 'C:\\outside.js' })], ['changed.js'], repoRoot)).toEqual([]);
  });
});

describe('getSuggestionDiffFiles Local snapshot', () => {
  let db;

  const patch = (...files) => files.map(file =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
  const insertLocalReview = () => Number(db.prepare(`INSERT INTO reviews (review_type, local_path, local_head_sha, status, repository)
    VALUES ('local', '/nonexistent/repo', 'head', 'draft', 'test/repo')`).run().lastInsertRowid);
  const review = id => db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);

  beforeEach(() => { db = createTestDatabase(); });
  afterEach(() => closeTestDatabase(db));

  it('lists the files of the current snapshot, following a rewrite', async () => {
    const reviewRepo = new ReviewRepository(db);
    const reviewId = insertLocalReview();
    await reviewRepo.saveLocalDiff(reviewId, { diff: patch('a.js', 'b.js'), stats: {}, digest: 'same' });
    expect(await getSuggestionDiffFiles(db, review(reviewId))).toEqual(['a.js', 'b.js']);

    await reviewRepo.saveLocalDiff(reviewId, { diff: patch('c.js'), stats: {}, digest: 'same' });
    expect(await getSuggestionDiffFiles(db, review(reviewId))).toEqual(['c.js']);
  });
});
