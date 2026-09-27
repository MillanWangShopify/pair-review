// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { run, query, CommentRepository } = require('../../src/database');
const ws = require('../../src/ws');
const suggestionStorage = require('../../src/utils/suggestion-storage');
const seedContextFiles = suggestionStorage.seedContextFilesForSuggestions;
const seedSpy = vi.spyOn(suggestionStorage, 'seedContextFilesForSuggestions');
const logger = require('../../src/utils/logger');
const reviewsRoutes = require('../../src/routes/reviews');
const prRoutes = require('../../src/routes/pr');

// Exercise the shared resolver against a real checkout, without a worktrees row.
describe.each(['pr', 'local'])('context selection and file reads (%s)', mode => {
  let db, server, repoRoot, reviewId, broadcastSpy;
  beforeEach(async () => {
    seedSpy.mockReset().mockImplementation(seedContextFiles);
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-context-selection-'));
    const git = args => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoRoot, 'changed.js'), 'before\n');
    fs.writeFileSync(path.join(repoRoot, 'helper.js'), 'first\nsecond\nthird\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial']);
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repoRoot, 'changed.js'), 'after\n');
    git(['add', '.']);
    git(['commit', '-m', 'change']);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const diff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    db = createTestDatabase();
    if (mode === 'pr') {
      await run(db, 'INSERT INTO pr_metadata (pr_number, repository, title, pr_data) VALUES (?, ?, ?, ?)',
        [1, 'owner/repo', 'Test', JSON.stringify({
          diff, base_sha: baseSha, head_sha: headSha, worktree_path: repoRoot,
          changed_files: [{ file: 'changed.js' }]
        })]);
      reviewId = (await run(db, 'INSERT INTO reviews (pr_number, repository, review_type, status) VALUES (?, ?, ?, ?)',
        [1, 'owner/repo', 'pr', 'draft'])).lastID;
    } else {
      reviewId = (await run(db, 'INSERT INTO reviews (repository, review_type, local_path, local_head_sha, status) VALUES (?, ?, ?, ?, ?)',
        ['owner/repo', 'local', repoRoot, headSha, 'draft'])).lastID;
      await run(db, 'INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)', [reviewId, diff]);
    }
    await run(db, 'INSERT INTO analysis_runs (id, review_id, provider, model, status) VALUES (?, ?, ?, ?, ?)',
      ['parent', reviewId, 'claude', 'test', 'completed']);
    await run(db, 'INSERT INTO analysis_runs (id, review_id, provider, model, status, parent_run_id) VALUES (?, ?, ?, ?, ?, ?)',
      ['voice', reviewId, 'claude', 'test', 'completed', 'parent']);
    await new CommentRepository(db).bulkInsertAISuggestions(reviewId, 'voice', [{
      file: 'helper.js', line_start: 2, line_end: 2, old_or_new: 'NEW',
      type: 'bug', title: 'Voice finding', description: 'Check this'
    }]);
    broadcastSpy = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use(reviewsRoutes);
    app.use(prRoutes);
    server = await listenOnLoopback(app);
  });
  afterEach(async () => {
    await closeServer(server);
    broadcastSpy?.mockRestore();
    closeTestDatabase(db);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('seeds one context and broadcasts once when selecting a child run, and does nothing on reselection', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await request(server).get(`/api/reviews/${reviewId}/suggestions?runId=voice`);
      expect(response.status).toBe(200);
      expect(response.body.suggestions).toHaveLength(1);
      await vi.waitFor(() => expect(seedSpy).toHaveBeenCalledTimes(i + 1));
      await seedSpy.mock.results[i].value;
      expect(await query(db, 'SELECT file FROM context_files WHERE review_id = ?', [reviewId])).toEqual([{ file: 'helper.js' }]);
      expect(broadcastSpy.mock.calls.filter(([, event]) => event.type === 'review:context_files_changed')).toHaveLength(1);
    }
  });

  it('uses saved findings without repeating file content validation', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile');
    try {
      const response = await request(server).get(`/api/reviews/${reviewId}/suggestions?runId=voice`);
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(broadcastSpy.mock.calls.filter(([, event]) => event.type === 'review:context_files_changed')).toHaveLength(1));
      expect(seedSpy).toHaveBeenCalledWith(db, reviewId, expect.any(Array), { validated: true });
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it('returns suggestions successfully when background context seeding fails', async () => {
    seedSpy.mockRejectedValueOnce(new Error('context seed unavailable'));
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const response = await request(server).get(`/api/reviews/${reviewId}/suggestions?runId=voice`);
      expect(response.status).toBe(200);
      expect(response.body.suggestions).toHaveLength(1);
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.stringContaining('context seed unavailable')));
      expect(await query(db, 'SELECT * FROM context_files')).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not seed voice panels when fetching the default or all runs', async () => {
    expect((await request(server).get(`/api/reviews/${reviewId}/suggestions`)).status).toBe(200);
    expect((await request(server).get(`/api/reviews/${reviewId}/suggestions?allRuns=true`)).status).toBe(200);
    expect((await request(server).get(`/api/reviews/${reviewId}/suggestions?allRuns=true&runId=voice`)).status).toBe(200);
    expect(await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [reviewId])).toHaveLength(0);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('does not seed panels from intermediate voice levels', async () => {
    await new CommentRepository(db).bulkInsertAISuggestions(reviewId, 'voice', [{
      file: 'helper.js', line_start: 3, line_end: 3, old_or_new: 'NEW',
      type: 'bug', title: 'Intermediate finding', description: 'Check this'
    }], 1);
    const response = await request(server).get(`/api/reviews/${reviewId}/suggestions?runId=voice&levels=1`);
    expect(response.status).toBe(200);
    expect(response.body.suggestions).toHaveLength(1);
    expect(seedSpy).not.toHaveBeenCalled();
    expect(await query(db, 'SELECT * FROM context_files')).toEqual([]);
  });

  it('serves context content from the resolved checkout', async () => {
    const response = await request(server).get(`/api/reviews/${reviewId}/file-content/helper.js?source=worktree`);
    expect(response.status).toBe(200);
    expect(response.body.lines).toEqual(['first', 'second', 'third', '']);
  });

  if (mode === 'pr') {
    it('uses the checkout fallback for diff expansion and legacy content reads', async () => {
      const expanded = await request(server).get(`/api/reviews/${reviewId}/file-contents/helper.js`);
      expect(expanded.status).toBe(200);
      expect(expanded.body.oldContents).toBe('first\nsecond\nthird\n');
      expect(expanded.body.newContents).toBe('first\nsecond\nthird\n');
      const legacy = await request(server).get('/api/file-content-original/helper.js').query({ owner: 'owner', repo: 'repo', number: 1 });
      expect(legacy.status).toBe(200);
      expect(legacy.body.lines).toEqual(['first', 'second', 'third', '']);
    });
  }
});

afterAll(() => seedSpy.mockRestore());
