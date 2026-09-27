// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { setImmediate } from 'node:timers';

const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { PRManager } = require('../../public/js/pr.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');
const PierreContext = require('../../public/js/modules/pierre-context.js');
// Browser-only module: registers window.LineTracker (the PRManager row lookup).
require('../../public/js/modules/line-tracker.js');

afterEach(() => {
  document.body.innerHTML = '';
  delete window.prManager;
  delete window.PierreContext;
  delete window.aiPanel;
  delete window.CommentManager;
  delete window.escapeHtmlAttribute;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('explicit feedback jumps to missing context panels', () => {
  function createManager() {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 1 };
    manager.diffFiles = [{ file: 'changed.js' }];
    manager.findFileElement = vi.fn(() => null);
    manager.ensureContextFile = vi.fn(async () => ({ type: 'context' }));
    return manager;
  }

  it('restores a missing panel around the requested line', async () => {
    const manager = createManager();
    await manager.ensureContextPanelForJump('outside.js', 180);
    expect(manager.ensureContextFile).toHaveBeenCalledWith('outside.js', 180);
  });

  it('does not create panels for missing input, diff files, covered wrappers, or unloaded reviews', async () => {
    const manager = createManager();
    await manager.ensureContextPanelForJump(null);
    await manager.ensureContextPanelForJump('changed.js');
    manager.findFileElement.mockReturnValue(document.createElement('div'));
    manager.contextFiles = [{ file: 'existing.js', line_start: 1, line_end: 50 }];
    await manager.ensureContextPanelForJump('existing.js');
    manager.currentPR = null;
    await manager.ensureContextPanelForJump('outside.js');
    expect(manager.ensureContextFile).not.toHaveBeenCalled();
  });

  it('reuses a wrapper that already renders the line outside every stored window', async () => {
    const manager = createManager();
    manager.lineTracker = new window.LineTracker();
    // The seeded window is 10-30; line 180 was revealed in place by a gap
    // expansion, so no stored entry covers it but its row is in the DOM.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<table><tbody class="context-chunk" data-context-id="9300">
      <tr class="context-expand-row" data-start-line="31" data-end-line="179"></tr>
      <tr data-line-number="180" data-old-line-number="180" data-new-line-number="180" data-side="RIGHT"></tr>
    </tbody></table>`;
    manager.findFileElement.mockReturnValue(wrapper);
    manager.contextFiles = [{ id: 9300, file: 'outside.js', line_start: 10, line_end: 30 }];

    await expect(manager.ensureContextPanelForJump('outside.js', 180)).resolves.toEqual({ type: 'context' });
    expect(manager.ensureContextFile).not.toHaveBeenCalled();

    // A line inside the collapsed gap still needs a new window.
    await manager.ensureContextPanelForJump('outside.js', 100);
    expect(manager.ensureContextFile.mock.calls).toEqual([['outside.js', 100]]);
  });

  it('shares an in-flight creation and permits another attempt after failure', async () => {
    const manager = createManager();
    let reject;
    manager.ensureContextFile.mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail; }));
    const first = manager.ensureContextPanelForJump('outside.js', 20);
    const second = manager.ensureContextPanelForJump('outside.js', 180);
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(manager.ensureContextFile).toHaveBeenCalledTimes(1));
    reject(new Error('unavailable'));
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
    await manager.ensureContextPanelForJump('outside.js', 180);
    expect(manager.ensureContextFile).toHaveBeenCalledTimes(2);
  });

  it('widens for a second target in the same file after the first jump', async () => {
    const manager = createManager();
    const wrapper = document.createElement('div');
    manager.ensureContextFile.mockImplementation(async (file, line) => {
      manager.contextFiles = [{ file, line_start: line - 10, line_end: line + 10 }];
      manager.findFileElement.mockReturnValue(wrapper);
      return { type: 'context' };
    });
    const first = manager.ensureContextPanelForJump('outside.js', 500);
    const second = manager.ensureContextPanelForJump('outside.js', 40);
    await Promise.all([first, second]);
    expect(manager.ensureContextFile.mock.calls).toEqual([
      ['outside.js', 500], ['outside.js', 40]
    ]);
  });
});

describe('overlapping suggestion renders', () => {
  function createManager() {
    document.body.innerHTML = '<div data-file-name="context.js"><table><tbody><tr data-line="20"></tr></tbody></table></div>';
    const sm = Object.create(SuggestionManager.prototype);
    sm.prManager = {
      ensureLinesVisible: vi.fn(async () => {}),
      lineTracker: { getLineNumber: row => Number(row.dataset.line) }
    };
    sm._closeReasoningPopover = vi.fn();
    sm.createSuggestionRow = vi.fn(suggestions => {
      const row = document.createElement('tr');
      row.className = 'ai-suggestion-row';
      row.dataset.suggestionId = suggestions[0].id;
      return row;
    });
    window.aiPanel = { addFindings: vi.fn() };
    return sm;
  }
  const findings = id => [{ id, file: 'context.js', line_start: 20 }];

  it('renders a second request queued before the first finishes', async () => {
    const sm = createManager();
    let release;
    sm.prManager.ensureLinesVisible.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = sm.displayAISuggestions(findings('first'));
    let secondFinished = false;
    const second = sm.displayAISuggestions(findings('second')).then(() => {
      expect(document.querySelector('.ai-suggestion-row').dataset.suggestionId).toBe('second');
      secondFinished = true;
    });
    await new Promise(setImmediate);
    expect(secondFinished).toBe(false);
    expect(sm.createSuggestionRow).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
    expect(document.querySelectorAll('.ai-suggestion-row')).toHaveLength(1);
    expect(document.querySelector('.ai-suggestion-row').dataset.suggestionId).toBe('second');
    expect(window.aiPanel.addFindings).toHaveBeenLastCalledWith(findings('second'));
    expect(sm._isDisplayingSuggestions).toBe(false);
    expect(sm._pendingSuggestions).toBeNull();
  });

  it('coalesces to the latest payload, including an empty refresh', async () => {
    const sm = createManager();
    let release;
    sm.prManager.ensureLinesVisible.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = sm.displayAISuggestions(findings('first'));
    const superseded = sm.displayAISuggestions(findings('superseded'));
    const latest = sm.displayAISuggestions([]);
    release();
    await Promise.all([first, superseded, latest]);
    expect(sm.createSuggestionRow).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.ai-suggestion-row')).toHaveLength(0);
    expect(window.aiPanel.addFindings).toHaveBeenLastCalledWith([]);
  });

  it('clears file-level AI cards when a queued empty payload wins', async () => {
    const sm = createManager();
    document.body.insertAdjacentHTML('beforeend', '<div class="file-comments-zone"><div class="file-comments-container"></div></div>');
    const zone = document.querySelector('.file-comments-zone');
    const fm = Object.create(FileCommentManager.prototype);
    fm.findZoneForFile = vi.fn(() => zone);
    fm.displayAISuggestion = vi.fn(() => {
      const card = document.createElement('div');
      card.className = 'file-comment-card ai-suggestion';
      zone.querySelector('.file-comments-container').appendChild(card);
    });
    fm.updateCommentCount = vi.fn();
    sm.prManager.fileCommentManager = fm;
    let release;
    sm.prManager.ensureLinesVisible.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = sm.displayAISuggestions([...findings('first'),
      { id: 'file', file: 'context.js', line_start: null, is_file_level: 1 }]);
    const second = sm.displayAISuggestions([]);
    release();
    await Promise.all([first, second]);
    expect(fm.displayAISuggestion).toHaveBeenCalledTimes(1);
    expect(zone.querySelectorAll('.file-comment-card.ai-suggestion')).toHaveLength(0);
    expect(fm.updateCommentCount).toHaveBeenCalledTimes(2);
  });

  it('drains the pending request even if the first render fails', async () => {
    const sm = createManager();
    let reject;
    sm.prManager.ensureLinesVisible.mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail; }));
    const first = sm.displayAISuggestions(findings('first'));
    const failure = expect(first).rejects.toThrow('render failed');
    const second = sm.displayAISuggestions(findings('second'));
    reject(new Error('render failed'));
    await Promise.all([failure, second]);
    expect(document.querySelector('.ai-suggestion-row').dataset.suggestionId).toBe('second');
    expect(sm._isDisplayingSuggestions).toBe(false);
  });

  it('rejects queued callers when their render fails and allows a later render', async () => {
    const sm = createManager();
    let release;
    sm.prManager.ensureLinesVisible
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockRejectedValueOnce(new Error('queued render failed'));
    const first = sm.displayAISuggestions(findings('first'));
    const second = sm.displayAISuggestions(findings('second'));
    const failures = Promise.allSettled([first, second]);
    release();
    expect((await failures).map(result => result.reason.message)).toEqual([
      'queued render failed', 'queued render failed'
    ]);
    expect(sm._isDisplayingSuggestions).toBe(false);
    expect(sm._pendingSuggestionsCompletion).toBeNull();
    await sm.displayAISuggestions(findings('recovered'));
    expect(document.querySelector('.ai-suggestion-row').dataset.suggestionId).toBe('recovered');
  });

  it('waits through requests queued during a pending render', async () => {
    const sm = createManager();
    const releases = [];
    sm.prManager.ensureLinesVisible.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const first = sm.displayAISuggestions(findings('first'));
    const second = sm.displayAISuggestions(findings('second'));
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const third = sm.displayAISuggestions(findings('third'));
    releases[1]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    let secondFinished = false;
    second.then(() => { secondFinished = true; });
    await new Promise(setImmediate);
    expect(secondFinished).toBe(false);
    releases[2]();
    await Promise.all([first, second, third]);
    expect(document.querySelector('.ai-suggestion-row').dataset.suggestionId).toBe('third');
  });
});

it('reveals every suggestion range in an outside-diff context file', async () => {
  const sm = Object.create(SuggestionManager.prototype);
  sm._closeReasoningPopover = vi.fn();
  sm.prManager = { ensureLinesVisible: vi.fn(async () => {}) };
  await sm.displayAISuggestions([
    { file: 'outside.js', line_start: 20, line_end: 150 },
    { file: 'outside.js', line_start: 180, line_end: 190, side: 'RIGHT' },
  ]);
  expect(sm.prManager.ensureLinesVisible).toHaveBeenCalledWith([
    { file: 'outside.js', line_start: 20, line_end: 150, side: 'RIGHT', contextPadding: 3 },
    { file: 'outside.js', line_start: 180, line_end: 190, side: 'RIGHT', contextPadding: 3 },
  ]);
});

describe.each([
  ['scrollToFinding', 'findings'],
  ['scrollToComment', 'comments'],
])('AIPanel.%s range navigation', (method, collection) => {
  it('waits for panel restoration and lets a newer navigation win', async () => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [];
    inst.expandFileIfCollapsed = vi.fn();
    const releases = [];
    window.prManager = {
      ensureContextPanelForJump: vi.fn(() => new Promise(resolve => releases.push(resolve))),
      ensureLinesVisible: vi.fn(async () => {})
    };
    const first = inst[method]('first', 'outside.js', 20);
    const second = inst[method]('second', 'other.js', 180);
    expect(inst.expandFileIfCollapsed).not.toHaveBeenCalled();
    releases[0]();
    releases[1]();
    await Promise.all([first, second]);
    expect(inst.expandFileIfCollapsed).toHaveBeenCalledTimes(1);
    expect(inst.expandFileIfCollapsed).toHaveBeenCalledWith('other.js');
    expect(window.prManager.ensureContextPanelForJump).toHaveBeenCalledWith('outside.js', 20);
  });

  it.each(['LEFT', 'RIGHT'])('reveals both endpoints on the %s side before looking up the card', async (side) => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [{ id: 1, line_start: 10, line_end: 50, side }];
    inst.expandFileIfCollapsed = vi.fn();
    inst._scrollDiffTarget = vi.fn();
    const card = document.createElement('div');
    card.className = 'ai-suggestion user-comment-row';
    card.dataset.suggestionId = '1';
    card.dataset.commentId = '1';
    let reveal;
    window.prManager = {
      ensureLinesVisible: vi.fn(() => new Promise(resolve => {
        reveal = () => { document.body.appendChild(card); resolve(); };
      })),
    };

    let completed = false;
    const navigation = inst[method]('1', 'a.js', '10').then(() => { completed = true; });
    // Let the caller settle if it forgot to await doScroll. The reveal promise
    // stays pending until the test releases it, independent of elapsed time.
    await new Promise(setImmediate);
    expect(completed).toBe(false);
    expect(inst._scrollDiffTarget).not.toHaveBeenCalled();
    reveal();
    await navigation;

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 10, line_end: 50, side },
    ]);
    expect(inst._scrollDiffTarget).toHaveBeenCalledWith(card);
  });

  it('falls back to the supplied line when the item is absent', async () => {
    const inst = Object.create(AIPanel.prototype);
    inst._navGen = 0;
    inst[collection] = [];
    inst.expandFileIfCollapsed = vi.fn();
    window.prManager = { ensureLinesVisible: vi.fn(async () => {}) };

    await inst[method]('missing', 'a.js', '30');

    expect(window.prManager.ensureLinesVisible).toHaveBeenCalledWith([
      { file: 'a.js', line_start: 30, line_end: 30, side: 'RIGHT' },
    ]);
  });
});

it('preserves comment context when refreshing to an empty suggestion list', async () => {
  window.PierreContext = PierreContext;
  const bridge = Object.create(PierreBridge.prototype);
  const instance = {
    render({ fileDiff }) { this.fileDiff = fileDiff; return false; },
  };
  bridge.files = new Map([['a.js', {
    fileName: 'a.js', instance, annotations: [], formElements: new Map(),
    baseMetadata: { hunks: [], additionLines: Array(100).fill('line') },
  }]]);
  bridge._updateAnnotations = vi.fn();
  bridge.addContextRanges('a.js', [{ startLine: 70, endLine: 80 }]);
  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);

  const sm = Object.create(SuggestionManager.prototype);
  sm.prManager = { pierreBridge: bridge };
  sm._closeReasoningPopover = vi.fn();
  await sm.displayAISuggestions([]);

  expect(bridge.isLineVisible('a.js', 80, 'RIGHT')).toBe(true);
});

it('keeps manually expanded comment anchors visible when revealing another location', () => {
  window.PierreContext = PierreContext;
  const bridge = Object.create(PierreBridge.prototype);
  const baseMetadata = {
    hunks: [{
      additionStart: 50, additionCount: 1, additionLines: 0,
      deletionStart: 50, deletionCount: 1, deletionLines: 0,
      splitLineCount: 1, unifiedLineCount: 1, collapsedBefore: 49,
    }],
    additionLines: Array(100).fill('line'),
    deletionLines: Array(100).fill('line'),
  };
  const expansions = new Map([
    [0, { fromStart: 10, fromEnd: 10 }],
    [1, { fromStart: 10, fromEnd: 0 }],
  ]);
  const instance = {
    fileDiff: baseMetadata,
    hunksRenderer: { expandedHunks: expansions, getExpandedHunk: i => expansions.get(i) },
    render({ fileDiff }) { this.fileDiff = fileDiff; return false; },
  };
  bridge.files = new Map([['a.js', { fileName: 'a.js', instance, baseMetadata }]]);
  expect(bridge.isLineVisible('a.js', 40, 'LEFT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 60, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 10, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 30, 'RIGHT')).toBe(false);

  bridge.addContextRanges('a.js', [{ startLine: 90, endLine: 90 }]);

  expect(expansions.size).toBe(0);
  expect(bridge.isLineVisible('a.js', 40, 'LEFT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 60, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 10, 'RIGHT')).toBe(true);
  expect(bridge.isLineVisible('a.js', 30, 'RIGHT')).toBe(false);
  expect(bridge.isLineVisible('a.js', 90, 'RIGHT')).toBe(true);
});

describe('reloading user comments', () => {
  it('keeps file-level AI cards when file-level user comments reload', async () => {
    window.escapeHtmlAttribute = value => String(value);
    window.CommentManager = { AI_ICON_SVG: '', PERSON_ICON_SVG: '' };
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 1 };
    const fm = new FileCommentManager(manager);
    manager.fileCommentManager = fm;
    const zone = fm.createFileCommentsZone('context.js');
    document.body.appendChild(zone);
    fm.loadFileComments(null, [
      { id: 21, file: 'context.js', is_file_level: 1, type: 'bug', title: 'AI finding', body: 'Look here' }
    ]);
    expect(zone.querySelectorAll('.file-comment-card.ai-suggestion')).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ comments: [
        { id: 31, file: 'context.js', is_file_level: 1, status: 'active', body: 'Mine' }
      ] }),
    })));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await manager.loadUserComments();

    expect(logged).not.toHaveBeenCalled();
    expect(zone.querySelectorAll('.file-comment-card.user-comment')).toHaveLength(1);
    const aiCards = zone.querySelectorAll('.file-comment-card.ai-suggestion');
    expect(aiCards).toHaveLength(1);
    expect(aiCards[0].dataset.suggestionId).toBe('21');
  });
});
