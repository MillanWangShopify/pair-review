// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execSync } from 'child_process';
import express from 'express';
import nodeFs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

/**
 * Create a throwaway git repo with an unstaged change so the real local-diff
 * helpers (generateLocalDiff/computeLocalDiffDigest) produce a non-empty diff
 * within the default 'unstaged'→'untracked' scope. Caller cleans up.
 */
function createTempRepoWithChanges(files = ['file.js']) {
  const tempRepo = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-analysis-results-'));
  execSync('git init -b main', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tempRepo, stdio: 'pipe' });
  for (const file of [...files, 'src/context.js']) {
    const repoFile = path.join(tempRepo, file);
    nodeFs.mkdirSync(path.dirname(repoFile), { recursive: true });
    nodeFs.writeFileSync(repoFile, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  }
  execSync('git add .', { cwd: tempRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tempRepo, stdio: 'pipe' });
  // Only these files change; src/context.js remains outside the diff.
  for (const file of files) {
    nodeFs.appendFileSync(path.join(tempRepo, file), 'added line\n');
  }
  return tempRepo;
}

// Mock modules that analysis routes depend on but we don't need
vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({}))
}));


vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false)
  })
}));

const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockImplementation(async () => fixtureRepo);

const configModule = require('../../src/config');
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  github_token: 'test-token',
  port: 7247,
  theme: 'light'
});
// Unique per test file so parallel forks never share a config dir on disk.
const testConfigDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-cfg-'));
const fixtureFiles = ['file.js', 'src/index.js', 'src/utils.js', 'app.js', 'a.js', 'b.js', 'c.js', 'README.md', 'utils.js', 'x.js', 'f.js'];
const fixtureRepo = createTempRepoWithChanges(fixtureFiles);
vi.spyOn(configModule, 'getConfigDir').mockReturnValue(testConfigDir);

afterAll(() => {
  nodeFs.rmSync(testConfigDir, { recursive: true, force: true });
  nodeFs.rmSync(fixtureRepo, { recursive: true, force: true });
});

const { query, queryOne, run, ReviewRepository } = require('../../src/database');
const { generateScopedDiff } = require('../../src/local-review');
const ws = require('../../src/ws');

const analysisRoutes = require('../../src/routes/analyses');

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    model: 'sonnet'
  });
  app.use('/', analysisRoutes);
  return app;
}

describe('POST /api/analyses/results', () => {
  let db;
  let app;
  let server;
  let broadcastSpy;

  beforeEach(async () => {
    broadcastSpy = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    db = createTestDatabase();
    for (const prNumber of [42, 77, 583]) {
      await run(db, `
        INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
        VALUES (?, ?, 'owner/repo', 'test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [`test-${prNumber}`, prNumber, fixtureRepo]);
      await run(db, 'INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)',
        [prNumber, 'owner/repo', JSON.stringify({ changed_files: fixtureFiles })]);
    }
    app = createTestApp(db);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    broadcastSpy.mockRestore();
    if (db) {
      closeTestDatabase(db);
    }
    vi.clearAllMocks();
  });

  // --- Validation ---

  it('should return 400 when no identification pair is provided', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when both identification pairs are provided', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        repo: 'owner/repo',
        prNumber: 1,
        suggestions: []
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('only one identification pair');
  });

  it('should return 400 when path is provided without headSha', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ path: fixtureRepo, suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when repo is provided without prNumber', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', suggestions: [] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Must provide either');
  });

  it('should return 400 when suggestions is not an array', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        suggestions: 'not-an-array'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('suggestions must be an array');
  });

  it('should return 400 when fileLevelSuggestions is not an array', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        suggestions: [],
        fileLevelSuggestions: 'not-an-array'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('fileLevelSuggestions must be an array');
  });

  it('should return 400 when a suggestion is missing required fields', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        suggestions: [{ file: 'test.js' }]
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/suggestions\[0\] missing required field/);
  });

  it('should return 400 when prNumber is not a positive integer', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: -1, suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when prNumber is zero', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: 0, suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when prNumber is not a number', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({ repo: 'owner/repo', prNumber: 'abc', suggestions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid pull request number');
  });

  it('should return 400 when tier is provided but invalid', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        tier: 'invalid-tier',
        suggestions: []
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid tier');
    expect(response.body.error).toContain('invalid-tier');
  });

  it('should accept canonical tier values', async () => {
    for (const tier of ['fast', 'balanced', 'thorough']) {
      const response = await request(server)
        .post('/api/analyses/results')
        .send({
          path: fixtureRepo,
          headSha: `sha-tier-${tier}`,
          tier,
          suggestions: []
        });

      expect(response.status).toBe(201);

      const { queryOne } = require('../../src/database');
      const run = await queryOne(db, 'SELECT tier FROM analysis_runs WHERE id = ?', [response.body.runId]);
      expect(run.tier).toBe(tier);
    }
  });

  it('should normalize tier aliases to canonical form', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha-alias',
        tier: 'premium',
        suggestions: []
      });

    expect(response.status).toBe(201);

    const { queryOne } = require('../../src/database');
    const run = await queryOne(db, 'SELECT tier FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(run.tier).toBe('thorough');
  });

  it('should allow null/undefined tier (external imports may omit it)', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha-no-tier',
        suggestions: []
      });

    expect(response.status).toBe(201);

    const { queryOne } = require('../../src/database');
    const run = await queryOne(db, 'SELECT tier FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(run.tier).toBeNull();
  });

  it('should return 400 when a file-level suggestion is missing required fields', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123',
        suggestions: [],
        fileLevelSuggestions: [{ file: 'test.js', type: 'bug' }]
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/fileLevelSuggestions\[0\] missing required field/);
  });

  // --- Local mode happy path ---

  it('should create analysis run and suggestions for local mode', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'abc123def',
        provider: 'claude',
        model: 'sonnet',
        summary: 'Found 2 issues',
        suggestions: [
          {
            file: 'src/index.js',
            line_start: 10,
            line_end: 15,
            old_or_new: 'NEW',
            type: 'bug',
            title: 'Null check missing',
            description: 'This could throw if input is null.',
            suggestion: 'Add a null check before accessing properties.',
            confidence: 0.9
          },
          {
            file: 'src/utils.js',
            line_start: 42,
            line_end: 42,
            old_or_new: 'OLD',
            type: 'improvement',
            title: 'Simplify expression',
            description: 'This boolean expression can be simplified.',
            confidence: 0.7
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.runId).toBeDefined();
    expect(response.body.reviewId).toBeDefined();
    expect(response.body.totalSuggestions).toBe(2);
    expect(response.body.status).toBe('completed');

    // Verify analysis_run was created with completed status
    const analysisRun = await queryOne(db, 'SELECT * FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun).toBeTruthy();
    expect(analysisRun.status).toBe('completed');
    expect(analysisRun.provider).toBe('claude');
    expect(analysisRun.model).toBe('sonnet');
    expect(analysisRun.summary).toBe('Found 2 issues');
    expect(analysisRun.total_suggestions).toBe(2);
    expect(analysisRun.files_analyzed).toBe(2);
    expect(analysisRun.completed_at).toBeTruthy();
    expect(analysisRun.head_sha).toBe('abc123def');

    // Verify comments were created
    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ? ORDER BY file', [response.body.runId]);
    expect(comments).toHaveLength(2);

    // First comment: src/index.js
    expect(comments[0].file).toBe('src/index.js');
    expect(comments[0].source).toBe('ai');
    expect(comments[0].ai_level).toBeNull();
    expect(comments[0].ai_confidence).toBe(0.9);
    expect(comments[0].line_start).toBe(10);
    expect(comments[0].line_end).toBe(15);
    expect(comments[0].side).toBe('RIGHT');
    expect(comments[0].type).toBe('bug');
    expect(comments[0].title).toBe('Null check missing');
    expect(comments[0].body).toBe('This could throw if input is null.');
    expect(comments[0].suggestion_text).toBe('Add a null check before accessing properties.');
    expect(comments[0].status).toBe('active');
    expect(comments[0].is_file_level).toBe(0);

    // Second comment: src/utils.js - OLD side maps to LEFT
    expect(comments[1].file).toBe('src/utils.js');
    expect(comments[1].side).toBe('LEFT');
    expect(comments[1].type).toBe('improvement');
  });

  // --- Durable diff persistence (local mode) ---

  it('should durably persist the local diff to the local_diffs table', async () => {
    const tempRepo = createTempRepoWithChanges();
    try {
      const headSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();

      const response = await request(server)
        .post('/api/analyses/results')
        .send({
          path: tempRepo,
          headSha,
          provider: 'claude',
          model: 'sonnet',
          summary: 'Found 1 issue',
          suggestions: [
            {
              file: 'file.js',
              line_start: 1,
              line_end: 1,
              old_or_new: 'NEW',
              type: 'bug',
              title: 'Example issue',
              description: 'Something to look at.',
              confidence: 0.8
            }
          ]
        });

      expect(response.status).toBe(201);
      expect(response.body.reviewId).toBeDefined();

      // The diff must be durably persisted to the local_diffs table so it
      // survives a restart and the manual tour/summary buttons never falsely
      // report "no-diff" for a review created via this analysis-push path.
      const reviewRepo = new ReviewRepository(db);
      const dbDiff = await reviewRepo.getLocalDiff(response.body.reviewId);
      expect(dbDiff).not.toBeNull();
      expect(dbDiff.diff).toContain('diff --git');
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  // --- PR mode happy path ---

  it.each([
    ['staged', false],
    ['branch', false],
    ['branch', true]
  ])('preserves changed LEFT findings in %s scope (refresh fails: %s)', async (scopeStart, refreshFails) => {
    const tempRepo = createTempRepoWithChanges(['file.js', 'café.js']);
    try {
      if (scopeStart === 'branch') execSync('git checkout -b feature', { cwd: tempRepo, stdio: 'pipe' });
      nodeFs.unlinkSync(path.join(tempRepo, 'café.js'));
      execSync('git add -A', { cwd: tempRepo, stdio: 'pipe' });
      if (scopeStart === 'branch') execSync('git commit -m "scoped changes"', { cwd: tempRepo, stdio: 'pipe' });
      // No unstaged changes: the default diff-file lookup misses both paths.
      expect(execSync('git diff --name-only', { cwd: tempRepo, encoding: 'utf8' }).trim()).toBe('');
      const headSha = execSync('git rev-parse HEAD', { cwd: tempRepo, encoding: 'utf8' }).trim();
      const reviewRepo = new ReviewRepository(db);
      const reviewId = await reviewRepo.upsertLocalReview({
        localPath: tempRepo, localHeadSha: headSha, repository: 'scoped/repo',
        localHeadBranch: scopeStart === 'branch' ? 'feature' : 'main',
        scopeStart, scopeEnd: 'unstaged', localBaseBranch: 'main'
      });
      if (refreshFails) {
        const snapshot = await generateScopedDiff(tempRepo, scopeStart, 'unstaged', 'main');
        await reviewRepo.saveLocalDiff(reviewId, snapshot);
        await run(db, 'UPDATE reviews SET local_base_branch = ? WHERE id = ?', ['missing-base-branch', reviewId]);
      }

      const response = await request(server).post('/api/analyses/results').send({
        path: tempRepo, headSha,
        suggestions: ['file.js', 'café.js', 'src/context.js'].map(file => ({
          file, line_start: 10, line_end: 12, old_or_new: 'OLD',
          type: 'bug', title: 'Scoped finding', description: 'Inspect these lines.'
        }))
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ reviewId, totalSuggestions: 3 });
      const comments = await query(db, 'SELECT file, side, line_start, line_end FROM comments WHERE ai_run_id = ? ORDER BY id', [response.body.runId]);
      expect(comments).toEqual([
        { file: 'file.js', side: 'LEFT', line_start: 10, line_end: 12 },
        { file: 'café.js', side: 'LEFT', line_start: 10, line_end: 12 },
        { file: 'src/context.js', side: 'RIGHT', line_start: 10, line_end: 12 }
      ]);
      expect(await query(db, 'SELECT file FROM context_files WHERE review_id = ?', [reviewId])).toEqual([{ file: 'src/context.js' }]);
    } finally {
      nodeFs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('should create analysis run and suggestions for PR mode', async () => {
    // Manually insert a review to test the "review already exists" code path
    // (contrast with the test below that verifies auto-creation when no review exists)
    await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, 'draft', 'pr')
    `, [42, 'owner/repo']);

    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 42,
        provider: 'antigravity',
        model: 'pro',
        summary: 'Looks good overall',
        suggestions: [
          {
            file: 'app.js',
            line_start: 5,
            line_end: 5,
            type: 'praise',
            title: 'Nice error handling',
            description: 'Good use of try/catch here.',
            confidence: 0.95
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(1);
    expect(response.body.status).toBe('completed');

    // Verify the suggestion was stored
    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comments).toHaveLength(1);
    expect(comments[0].file).toBe('app.js');
    expect(comments[0].type).toBe('praise');
  });

  it('imports a fresh PR without metadata or a worktree, preserving sides and totals', async () => {
    expect(await queryOne(db, 'SELECT * FROM pr_metadata WHERE pr_number = 99')).toBeUndefined();
    expect(await queryOne(db, 'SELECT * FROM worktrees WHERE pr_number = 99')).toBeUndefined();
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 99,
        suggestions: ['OLD', 'NEW'].map((old_or_new, index) => ({
          file: `./src/file${index}.js`, line_start: 10, line_end: 12, old_or_new,
          type: 'bug', title: 'Imported issue', description: 'Preserve this finding.'
        }))
      });

    expect(response.status).toBe(201);
    expect(response.body.reviewId).toBeDefined();
    expect(response.body.totalSuggestions).toBe(2);
    expect(await query(db, 'SELECT file, side FROM comments WHERE ai_run_id = ? ORDER BY id', [response.body.runId])).toEqual([
      { file: 'src/file0.js', side: 'LEFT' }, { file: 'src/file1.js', side: 'RIGHT' }
    ]);
    expect(await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [response.body.reviewId])).toEqual([]);

    // Verify review was created
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [response.body.reviewId]);
    expect(review).toBeTruthy();
    expect(review.pr_number).toBe(99);
    expect(review.repository).toBe('owner/repo');
    expect(review.review_type).toBe('pr');
  });

  // --- Empty suggestions ---

  describe.each(['Local', 'PR'])('%s out-of-diff suggestions', (mode) => {
    function payload(suggestions) {
      return {
        ...(mode === 'Local'
          ? { path: fixtureRepo, headSha: 'context-import-sha' }
          : { repo: 'owner/repo', prNumber: 583 }),
        suggestions
      };
    }

    function finding(overrides = {}) {
      return {
        file: 'src/context.js', line_start: 30, line_end: 35,
        old_or_new: 'OLD', type: 'bug', title: 'Cross-file issue',
        description: 'The unchanged caller needs to handle the updated contract.',
        ...overrides
      };
    }

    it('creates one context range when importing and no additional range on repeat import', async () => {
      const body = payload([finding(), finding({ line_start: 32, line_end: 33 })]);
      const first = await request(server).post('/api/analyses/results').send(body);
      expect(first.status).toBe(201);
      expect(first.body.totalSuggestions).toBe(2);

      const reviewId = first.body.reviewId;
      const contextFiles = await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [reviewId]);
      expect(contextFiles).toHaveLength(1);
      expect(contextFiles[0]).toMatchObject({ file: 'src/context.js', line_start: 20, line_end: 45 });

      // An unchanged file has no LEFT side; preserve its actual file line numbers.
      const comments = await query(db,
        'SELECT file, side, line_start, line_end FROM comments WHERE ai_run_id = ? ORDER BY line_start',
        [first.body.runId]);
      expect(comments).toEqual([
        { file: 'src/context.js', side: 'RIGHT', line_start: 30, line_end: 35 },
        { file: 'src/context.js', side: 'RIGHT', line_start: 32, line_end: 33 }
      ]);

      const contextBroadcasts = () => broadcastSpy.mock.calls.filter(
        ([topic, event]) => topic === `review:${reviewId}` && event.type === 'review:context_files_changed'
      );
      expect(contextBroadcasts()).toHaveLength(1);
      broadcastSpy.mockClear();

      const second = await request(server).post('/api/analyses/results').send(body);
      expect(second.status).toBe(201);
      expect(second.body.reviewId).toBe(reviewId);
      expect(second.body.totalSuggestions).toBe(2);
      expect(await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [reviewId])).toEqual(contextFiles);
      expect(contextBroadcasts()).toHaveLength(0);
    });

    it('drops nonexistent and unsafe paths while storing existing unchanged files', async () => {
      const response = await request(server).post('/api/analyses/results').send(payload([
        finding(),
        finding({ file: 'src/nonexistent.js' }),
        finding({ file: '../context.js' }),
        finding({ file: path.join(fixtureRepo, 'src/context.js') }),
        finding({ file: 'src' })
      ]));
      expect(response.status).toBe(201);
      expect(response.body.totalSuggestions).toBe(1);
      const comments = await query(db, 'SELECT file FROM comments WHERE ai_run_id = ?', [response.body.runId]);
      expect(comments).toEqual([{ file: 'src/context.js' }]);
      const contexts = await query(db, 'SELECT file FROM context_files WHERE review_id = ?', [response.body.reviewId]);
      expect(contexts).toEqual([{ file: 'src/context.js' }]);
    });

    it('converts an out-of-range unchanged finding and seeds a safe context window', async () => {
      const response = await request(server).post('/api/analyses/results').send(payload([
        finding({ line_start: 900, line_end: 910 })
      ]));
      expect(response.status).toBe(201);
      expect(response.body.totalSuggestions).toBe(1);
      expect(await query(db, 'SELECT file, line_start, is_file_level FROM comments WHERE ai_run_id = ?', [response.body.runId]))
        .toEqual([{ file: 'src/context.js', line_start: null, is_file_level: 1 }]);
      expect(await query(db, 'SELECT file, line_start, line_end FROM context_files WHERE review_id = ?', [response.body.reviewId]))
        .toEqual([{ file: 'src/context.js', line_start: 1, line_end: 50 }]);
    });

    it('preserves a LEFT-side finding when the changed file is shorter in the checkout', async () => {
      const filePath = path.join(fixtureRepo, 'file.js');
      const original = nodeFs.readFileSync(filePath, 'utf8');
      try {
        nodeFs.writeFileSync(filePath, 'remaining line\n');
        const response = await request(server).post('/api/analyses/results').send(payload([
          finding({ file: 'file.js', old_or_new: 'OLD', line_start: 70, line_end: 75 })
        ]));
        expect(response.status).toBe(201);
        const comments = await query(db,
          'SELECT file, side, line_start, line_end FROM comments WHERE review_id = ? AND ai_run_id = ?',
          [response.body.reviewId, response.body.runId]);
        expect(comments).toEqual([
          { file: 'file.js', side: 'LEFT', line_start: 70, line_end: 75 }
        ]);
        expect(await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [response.body.reviewId])).toEqual([]);
      } finally {
        nodeFs.writeFileSync(filePath, original);
      }
    });

    it('rolls back context creation and sends no context event if an insert fails', async () => {
      await run(db, `
        CREATE TRIGGER reject_imported_suggestion BEFORE INSERT ON comments
        WHEN NEW.title = 'Reject this finding'
        BEGIN SELECT RAISE(ABORT, 'injected suggestion failure'); END
      `);
      const response = await request(server).post('/api/analyses/results').send(payload([
        finding(), finding({ title: 'Reject this finding' })
      ]));

      expect(response.status).toBe(500);
      expect(await query(db, 'SELECT * FROM comments')).toEqual([]);
      expect(await query(db, 'SELECT * FROM context_files')).toEqual([]);
      expect(await query(db, 'SELECT * FROM analysis_runs')).toEqual([]);
      expect(broadcastSpy.mock.calls.filter(
        ([, event]) => event.type === 'review:context_files_changed'
      )).toHaveLength(0);
    });
  });

  it('should create a run with zero suggestions', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'deadbeef',
        summary: 'No issues found',
        suggestions: []
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(0);

    const analysisRun = await queryOne(db, 'SELECT * FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun.total_suggestions).toBe(0);
    expect(analysisRun.files_analyzed).toBe(0);
    expect(analysisRun.summary).toBe('No issues found');
  });

  // --- Side mapping ---

  it('should map OLD to LEFT and NEW to RIGHT', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha1',
        suggestions: [
          {
            file: 'a.js', line_start: 1, line_end: 1, old_or_new: 'OLD',
            type: 'bug', title: 'Old side', description: 'desc'
          },
          {
            file: 'b.js', line_start: 2, line_end: 2, old_or_new: 'NEW',
            type: 'bug', title: 'New side', description: 'desc'
          },
          {
            file: 'c.js', line_start: 3, line_end: 3,
            type: 'bug', title: 'Default side', description: 'desc'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comments = await query(db,
      'SELECT file, side FROM comments WHERE ai_run_id = ? ORDER BY file',
      [response.body.runId]
    );

    expect(comments[0]).toEqual({ file: 'a.js', side: 'LEFT' });
    expect(comments[1]).toEqual({ file: 'b.js', side: 'RIGHT' });
    expect(comments[2]).toEqual({ file: 'c.js', side: 'RIGHT' }); // default
  });

  // --- File-level suggestions ---

  it('should store file-level suggestions with is_file_level=1 and null line numbers', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha2',
        suggestions: [],
        fileLevelSuggestions: [
          {
            file: 'README.md',
            type: 'suggestion',
            title: 'Add examples section',
            description: 'README would benefit from usage examples.',
            confidence: 0.6
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(1);

    const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comments).toHaveLength(1);
    expect(comments[0].is_file_level).toBe(1);
    expect(comments[0].line_start).toBeNull();
    expect(comments[0].line_end).toBeNull();
    expect(comments[0].file).toBe('README.md');
  });

  // --- Summary written to analysis_run record ---

  it('should store summary on the analysis_run record', async () => {
    const summary = 'This PR introduces 3 new utility functions. Overall quality is high.';
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha3',
        summary,
        suggestions: [
          {
            file: 'utils.js', line_start: 1, line_end: 1,
            type: 'praise', title: 'Clean code', description: 'Well structured.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const analysisRun = await queryOne(db, 'SELECT summary FROM analysis_runs WHERE id = ?', [response.body.runId]);
    expect(analysisRun.summary).toBe(summary);
  });

  // --- Suggestion body formatting ---

  it('should format suggestion body with description and suggestion text', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha4',
        suggestions: [
          {
            file: 'x.js', line_start: 1, line_end: 1,
            type: 'bug', title: 'Issue',
            description: 'There is a problem.',
            suggestion: 'Fix it like this.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comment = await queryOne(db, 'SELECT body, suggestion_text FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comment.body).toBe('There is a problem.');
    expect(comment.suggestion_text).toBe('Fix it like this.');
  });

  it('should format suggestion body without suggestion text when absent', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha5',
        suggestions: [
          {
            file: 'x.js', line_start: 1, line_end: 1,
            type: 'praise', title: 'Nice',
            description: 'Well done.'
          }
        ]
      });

    expect(response.status).toBe(201);

    const comment = await queryOne(db, 'SELECT body FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comment.body).toBe('Well done.');
  });

  it('should store suggestion blocks in suggestion_text without concatenation', async () => {
    const suggestionBlock = '```suggestion\nconst x = 1;\n```';
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha-backtick',
        suggestions: [
          {
            file: 'x.js', line_start: 1, line_end: 1,
            type: 'bug', title: 'Fix variable',
            description: 'Use const instead of var.',
            suggestion: suggestionBlock
          }
        ]
      });

    expect(response.status).toBe(201);

    const comment = await queryOne(db, 'SELECT body, suggestion_text FROM comments WHERE ai_run_id = ?', [response.body.runId]);
    expect(comment.body).toBe('Use const instead of var.');
    expect(comment.suggestion_text).toBe(suggestionBlock);
  });

  // --- Mixed line-level and file-level suggestions ---

  it('should handle both line-level and file-level suggestions in one request', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha6',
        suggestions: [
          {
            file: 'a.js', line_start: 10, line_end: 12,
            type: 'bug', title: 'Line bug', description: 'Bug on line 10.'
          }
        ],
        fileLevelSuggestions: [
          {
            file: 'a.js',
            type: 'design', title: 'File structure', description: 'Consider reorganizing.'
          }
        ]
      });

    expect(response.status).toBe(201);
    expect(response.body.totalSuggestions).toBe(2);
    expect(response.body.reviewId).toBeDefined();

    const comments = await query(db,
      'SELECT is_file_level, line_start FROM comments WHERE ai_run_id = ? ORDER BY is_file_level',
      [response.body.runId]
    );
    expect(comments).toHaveLength(2);
    // Line-level first (is_file_level=0)
    expect(comments[0].is_file_level).toBe(0);
    expect(comments[0].line_start).toBe(10);
    // File-level second (is_file_level=1)
    expect(comments[1].is_file_level).toBe(1);
    expect(comments[1].line_start).toBeNull();
  });

  // --- Line normalization ---

  it('should normalize line to line_start/line_end', async () => {
    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'sha-norm',
        suggestions: [{
          file: 'a.js', line: 10,
          type: 'bug', title: 'Test', description: 'Test'
        }]
      });
    expect(response.status).toBe(201);
    const comment = await queryOne(db,
      'SELECT line_start, line_end FROM comments WHERE ai_run_id = ?',
      [response.body.runId]);
    expect(comment.line_start).toBe(10);
    expect(comment.line_end).toBe(10);
  });

  // --- Idempotent local review upsert ---

  it('should reuse existing local review on repeat POST with same path+headSha', async () => {
    const payload = {
      path: fixtureRepo,
      headSha: 'sameSha',
      suggestions: [
        {
          file: 'f.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'A bug.'
        }
      ]
    };

    const first = await request(server).post('/api/analyses/results').send(payload);
    const second = await request(server).post('/api/analyses/results').send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Same review, different run IDs
    expect(first.body.reviewId).toBe(second.body.reviewId);
    expect(first.body.runId).not.toBe(second.body.runId);
  });

  // --- Review event broadcast ---

  it('should broadcast review:analysis_completed event for local mode', async () => {
    broadcastSpy.mockClear();

    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        path: fixtureRepo,
        headSha: 'ssesha1',
        suggestions: [{
          file: 'a.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'desc'
        }]
      });

    expect(response.status).toBe(201);
    const reviewId = response.body.reviewId;

    // Verify broadcastReviewEvent fires on the review:{reviewId} topic
    const reviewEventBroadcasts = broadcastSpy.mock.calls.filter(
      ([topic, payload]) => topic === `review:${reviewId}` && payload.type === 'review:analysis_completed'
    );
    expect(reviewEventBroadcasts.length).toBeGreaterThanOrEqual(1);

    // Verify broadcast payload contains expected fields
    const localPayload = reviewEventBroadcasts[0][1];
    expect(localPayload.reviewId).toBe(reviewId);
    expect(localPayload.type).toBe('review:analysis_completed');
  });

  it('should broadcast review:analysis_completed event for PR mode', async () => {
    broadcastSpy.mockClear();

    const response = await request(server)
      .post('/api/analyses/results')
      .send({
        repo: 'owner/repo',
        prNumber: 77,
        suggestions: [{
          file: 'b.js', line_start: 1, line_end: 1,
          type: 'bug', title: 'Bug', description: 'desc'
        }]
      });

    expect(response.status).toBe(201);
    const reviewId = response.body.reviewId;

    // Verify broadcastReviewEvent fires on the review:{reviewId} topic
    const reviewEventBroadcasts = broadcastSpy.mock.calls.filter(
      ([topic, payload]) => topic === `review:${reviewId}` && payload.type === 'review:analysis_completed'
    );
    expect(reviewEventBroadcasts.length).toBeGreaterThanOrEqual(1);

    // Verify broadcast payload contains expected fields
    const prPayload = reviewEventBroadcasts[0][1];
    expect(prPayload.reviewId).toBe(reviewId);
    expect(prPayload.type).toBe('review:analysis_completed');
  });
});

describe('GET /api/analyses/active', () => {
  const { activeAnalyses } = require('../../src/routes/shared');
  let db;
  let app;
  let server;

  beforeEach(async () => {
    activeAnalyses.clear();
    db = createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    activeAnalyses.clear();
    if (db) closeTestDatabase(db);
  });

  it('should return empty array when no active analyses', async () => {
    const res = await request(server).get('/api/analyses/active').expect(200);
    expect(res.body.active).toEqual([]);
  });

  it('should return only running analyses', async () => {
    activeAnalyses.set('running-1', {
      id: 'running-1',
      reviewId: 10,
      reviewType: 'pr',
      repository: 'owner/repo',
      prNumber: 42,
      status: 'running'
    });
    activeAnalyses.set('completed-1', {
      id: 'completed-1',
      reviewId: 20,
      status: 'completed'
    });
    activeAnalyses.set('failed-1', {
      id: 'failed-1',
      reviewId: 30,
      status: 'failed'
    });

    const res = await request(server).get('/api/analyses/active').expect(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toEqual({
      analysisId: 'running-1',
      reviewId: 10,
      reviewType: 'pr',
      repository: 'owner/repo',
      prNumber: 42
    });
  });

  it('should return multiple running analyses', async () => {
    activeAnalyses.set('pr-analysis', {
      id: 'pr-analysis',
      reviewId: 5,
      reviewType: 'pr',
      repository: 'org/project',
      prNumber: 99,
      status: 'running'
    });
    activeAnalyses.set('local-analysis', {
      id: 'local-analysis',
      reviewId: 8,
      reviewType: 'local',
      repository: 'my-project',
      status: 'running'
    });

    const res = await request(server).get('/api/analyses/active').expect(200);
    expect(res.body.active).toHaveLength(2);

    const prEntry = res.body.active.find(a => a.reviewType === 'pr');
    expect(prEntry.prNumber).toBe(99);

    const localEntry = res.body.active.find(a => a.reviewType === 'local');
    expect(localEntry.prNumber).toBeNull();
  });

  it('should handle missing optional fields gracefully', async () => {
    activeAnalyses.set('minimal', {
      id: 'minimal',
      reviewId: 1,
      status: 'running'
    });

    const res = await request(server).get('/api/analyses/active').expect(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toEqual({
      analysisId: 'minimal',
      reviewId: 1,
      reviewType: null,
      repository: null,
      prNumber: null
    });
  });
});
