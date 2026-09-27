// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';

const { prepareHeadlessReviewComments } = require('../../src/main');
const logger = require('../../src/utils/logger');

afterEach(() => vi.restoreAllMocks());

const finding = (overrides = {}) => ({
  id: 1, file: 'changed.js', line_start: 12, body: 'Check this caller.',
  type: 'bug', ai_level: null, status: 'active', ...overrides
});

describe('headless GitHub review comments', () => {
  it('preserves LEFT-side findings and defaults missing side to RIGHT', () => {
    const result = prepareHeadlessReviewComments([
      finding({ side: 'LEFT' }), finding({ id: 2 })
    ], ['changed.js']);
    expect(result.githubComments.map(comment => comment.side)).toEqual(['LEFT', 'RIGHT']);
  });

  it('excludes unchanged final findings from the payload and submitted IDs', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const changed = finding();
    const unchanged = finding({ id: 2, file: 'unchanged.js' });

    const result = prepareHeadlessReviewComments([changed, unchanged], [{ file: 'changed.js' }]);

    expect(result.githubComments).toEqual([{
      path: 'changed.js', line: 12, body: expect.stringContaining('Check this caller.'),
      side: 'RIGHT', isFileLevel: false
    }]);
    expect(result.validSuggestions.map(s => s.id)).toEqual([1]);
    expect(unchanged.status).toBe('active');
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('unchanged.js:12 - file is outside the PR diff'));
  });

  it('matches normalized renamed destinations in changed-file objects and strings', () => {
    const result = prepareHeadlessReviewComments([
      finding({ file: './src/new.js' }),
      finding({ id: 2, file: 'other/new.js' })
    ], [{ file: 'src/{old.js => new.js}' }, 'other/old.js => other/new.js']);

    expect(result.githubComments.map(comment => comment.path)).toEqual(['src/new.js', 'other/new.js']);
  });

  it('recovers a changed path from the PR diff when metadata is empty', () => {
    const diff = 'diff --git a/src/changed.js b/src/changed.js\n--- a/src/changed.js\n+++ b/src/changed.js\n';
    const result = prepareHeadlessReviewComments([finding({ file: './src/changed.js' })], [], diff);
    expect(result.githubComments).toMatchObject([{ path: 'src/changed.js' }]);
  });

  it('does not submit missing or invalid line/path data', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = prepareHeadlessReviewComments([
      null, finding({ line_start: null }), finding({ line_start: 0 }),
      finding({ file: '' }), finding({ file: '../changed.js' })
    ], ['changed.js']);

    expect(result).toEqual({ validSuggestions: [], githubComments: [] });
  });

  it('creates no inline payload when the diff has no changed files', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(prepareHeadlessReviewComments([finding()], [])).toEqual({ validSuggestions: [], githubComments: [] });
    expect(prepareHeadlessReviewComments(null, null)).toEqual({ validSuggestions: [], githubComments: [] });
  });
});
