// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Which version the file-content endpoint serves is the client's call:
 * context entries (files outside the diff) send ?source=worktree, diff files
 * never do. Gap rows exist in both kinds of wrapper, and one path can have
 * both (#540), so each fetch must follow the wrapper its row lives in.
 *
 * Shared by PR mode and Local mode: Local mode reuses these PRManager methods
 * unpatched (the server ignores the flag in PR mode).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

const FILE = 'src/app.js';
const LINES = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
const DIFF_URL = `/api/reviews/7/file-content/${encodeURIComponent(FILE)}`;
const WORKTREE_URL = `${DIFF_URL}?source=worktree`;

function createManager() {
  const manager = Object.create(PRManager.prototype);
  manager.currentPR = { id: 7 };
  manager.renderDiffLine = vi.fn(() => null);
  return manager;
}

function buildWrapperWithGap({ context }) {
  const wrapper = document.createElement('div');
  wrapper.className = context ? 'd2h-file-wrapper context-file' : 'd2h-file-wrapper';
  wrapper.dataset.fileName = FILE;
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  const gapRow = document.createElement('tr');
  gapRow.className = 'context-expand-row';
  gapRow.expandControls = {
    dataset: { fileName: FILE, startLine: '2', endLine: '5', startLineNew: '2', position: 'between' }
  };
  tbody.appendChild(gapRow);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  document.body.appendChild(wrapper);
  return { wrapper, gapRow };
}

const fetchedUrls = () => global.fetch.mock.calls.map(([url]) => url);

describe('file-content source selection', () => {
  let manager;

  beforeEach(() => {
    document.body.innerHTML = '';
    manager = createManager();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ lines: LINES }) });
    window.GapCoordinates = {
      getGapCoordinates: vi.fn(() => ({ gapStart: 2, gapEnd: 5, gapStartNew: 2, gapEndNew: 5, offset: 0 }))
    };
    window.HunkParser = {
      EOF_SENTINEL: -1,
      createGapRowElement: vi.fn(() => {
        const row = document.createElement('tr');
        row.expandControls = { dataset: {} };
        return row;
      })
    };
    window.DiffRenderer = { removeStrandedHunkHeaders: vi.fn(), updateFunctionContextVisibility: vi.fn() };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete window.GapCoordinates;
    delete window.HunkParser;
    delete window.DiffRenderer;
    vi.restoreAllMocks();
  });

  describe('fetchFileContent', () => {
    it('omits the source flag by default (diff files)', async () => {
      expect(await manager.fetchFileContent(FILE)).toEqual({ lines: LINES });
      expect(fetchedUrls()).toEqual([DIFF_URL]);
    });

    it('sends source=worktree for a context entry', async () => {
      await manager.fetchFileContent(FILE, { worktree: true });
      expect(fetchedUrls()).toEqual([WORKTREE_URL]);
    });

    it('omits the flag when worktree is false', async () => {
      await manager.fetchFileContent(FILE, { worktree: false });
      expect(fetchedUrls()).toEqual([DIFF_URL]);
    });

    it('does not fetch without a review id', async () => {
      manager.currentPR = null;
      expect(await manager.fetchFileContent(FILE, { worktree: true })).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('_fileContentOptionsFor', () => {
    it('reads the working tree for a context wrapper and anything inside it', () => {
      const { wrapper, gapRow } = buildWrapperWithGap({ context: true });
      expect(manager._fileContentOptionsFor(wrapper)).toEqual({ worktree: true });
      expect(manager._fileContentOptionsFor(gapRow)).toEqual({ worktree: true });
    });

    it('reads the diff version for a diff wrapper and anything inside it', () => {
      const { wrapper, gapRow } = buildWrapperWithGap({ context: false });
      expect(manager._fileContentOptionsFor(wrapper)).toEqual({ worktree: false });
      expect(manager._fileContentOptionsFor(gapRow)).toEqual({ worktree: false });
    });

    it('defaults to the diff version for a missing or detached element', () => {
      expect(manager._fileContentOptionsFor(null)).toEqual({ worktree: false });
      expect(manager._fileContentOptionsFor(undefined)).toEqual({ worktree: false });
      expect(manager._fileContentOptionsFor(document.createElement('tr'))).toEqual({ worktree: false });
    });
  });

  // Same path in both wrappers (#540): the row's wrapper decides.
  describe.each([
    ['diff', false, DIFF_URL],
    ['context', true, WORKTREE_URL]
  ])('gap expansion in a %s wrapper', (_label, context, expectedUrl) => {
    let diffGap;
    let contextGap;

    beforeEach(() => {
      diffGap = buildWrapperWithGap({ context: false }).gapRow;
      contextGap = buildWrapperWithGap({ context: true }).gapRow;
    });

    it('expandGapContext fetches the matching version', async () => {
      const gapRow = context ? contextGap : diffGap;
      await manager.expandGapContext(gapRow.expandControls, 'all', 0);
      expect(fetchedUrls()).toEqual([expectedUrl]);
      expect(manager.renderDiffLine).toHaveBeenCalledTimes(4);
    });

    it('expandGapRange fetches the matching version', async () => {
      const gapRow = context ? contextGap : diffGap;
      await manager.expandGapRange(gapRow, gapRow.expandControls, 3, 4);
      expect(fetchedUrls()).toEqual([expectedUrl]);
      expect(manager.renderDiffLine).toHaveBeenCalledTimes(2);
    });
  });

  it('validates pending end-of-file gaps against the diff version', async () => {
    const { gapRow } = buildWrapperWithGap({ context: false });
    gapRow.setAttribute('data-pending-eof-validation', 'true');
    await manager.validatePendingEofGaps();
    expect(fetchedUrls()).toEqual([DIFF_URL]);
    expect(gapRow.hasAttribute('data-pending-eof-validation')).toBe(false);
  });
});
