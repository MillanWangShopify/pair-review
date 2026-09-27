// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { test, expect } from './fixtures.js';
import { waitForDiffToRender } from './helpers.js';

const FILE = 'src/main.js';
const CONTEXT_FILE = 'src/unchanged.js';
const MODES = [
  { name: 'PR', path: '/pr/test-owner/test-repo/1', diff: '**/api/pr/*/*/*/diff' },
  { name: 'Local', path: '/local/2', diff: '**/api/local/2/diff' }
];

function feedback(id, line, source = 'user', end = line) {
  return {
    id, source, file: FILE, line_start: line, line_end: end, side: 'RIGHT',
    body: `Feedback ${id}`, status: 'active', is_file_level: 0,
    ...(source === 'ai' ? { type: 'bug', title: `Suggestion ${id}`, ai_level: null } : {})
  };
}

async function setup(page, mode, state) {
  const oldLines = Array.from({ length: 200 }, (_, index) => `// line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[99] = '// changed line 100';
  const diff = [
    `diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`,
    '@@ -97,7 +97,7 @@',
    ...oldLines.slice(96, 99).map(line => ` ${line}`),
    `-${oldLines[99]}`, `+${newLines[99]}`,
    ...oldLines.slice(100, 103).map(line => ` ${line}`), ''
  ].join('\n');

  await page.route(mode.diff, route => route.fulfill({ json: {
    diff, changed_files: [{ file: FILE, additions: 1, deletions: 1 }],
    stats: { files_changed: 1, additions: 1, deletions: 1 }
  } }));
  await page.route('**/api/reviews/*/file-contents/**', route => route.fulfill({ json: {
    fileName: FILE, oldContents: oldLines.join('\n'), newContents: newLines.join('\n')
  } }));
  state.fileContentUrls = [];
  await page.route('**/api/reviews/*/file-content/**', route => {
    state.fileContentUrls.push(new URL(route.request().url()));
    return route.fulfill({ json: { lines: oldLines } });
  });
  state.contextFiles ||= [];
  state.contextAdds = [];
  await page.route('**/api/reviews/*/context-files', async route => {
    if (route.request().method() === 'POST') {
      // Fresh ids: reusing a seeded id would hide a duplicate row, because
      // loadContextFiles renders only ids it has not seen.
      const entry = { ...route.request().postDataJSON(), id: 9900 + state.contextAdds.length };
      state.contextAdds.push(entry);
      state.contextFiles.push(entry);
      await route.fulfill({ status: 201, json: { contextFile: entry } });
    } else {
      await state.contextReady;
      await route.fulfill({ json: { contextFiles: state.contextFiles } });
    }
  });
  await page.route('**/api/reviews/*/context-files/*', async route => {
    const id = Number(route.request().url().split('/').pop());
    state.contextFiles = state.contextFiles.filter(entry => entry.id !== id);
    await route.fulfill({ json: { success: true } });
  });
  await page.route(/\/api\/reviews\/\d+\/comments(\?|$)/,
    route => route.fulfill({ json: { comments: state.comments } }));
  await page.route(/\/api\/reviews\/\d+\/suggestions(\?|$)/, route => {
    const runId = new URL(route.request().url()).searchParams.get('runId');
    return route.fulfill({ json: { suggestions: state.suggestionsByRun?.[runId] ?? state.suggestions } });
  });
  // Keep analysis history from selecting a run during the test. Context-file
  // loading can also reload suggestions once their wrappers are rendered.
  await page.route('**/api/analyses/runs*',
    route => route.fulfill({ json: { runs: [] } }));
  await page.route('**/api/local/2/check-stale',
    route => route.fulfill({ json: { isStale: false } }));
  await page.goto(mode.path);
  await waitForDiffToRender(page);
  // The history manager is created after the panel and initial comments load.
  await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
  await page.evaluate(() => window.prManager.loadAISuggestions());
}

function inlineComment(page, id) {
  return page.locator(`.pierre-diff-body .user-comment-row[data-comment-id="${id}"]`);
}

function inlineSuggestion(page, id) {
  return page.locator(`.pierre-diff-body .ai-suggestion[data-suggestion-id="${id}"]`);
}

for (const mode of MODES) {
  test.describe(`Inline feedback context (${mode.name})`, () => {
    test('server-created context files expose every suggestion range', async ({ page }) => {
      const state = {
        contextFiles: [{ id: 9300, file: CONTEXT_FILE, line_start: 10, line_end: 30 }],
        comments: [{ ...feedback(9104, 50), file: CONTEXT_FILE }],
        suggestions: [
          { ...feedback(9204, 20, 'ai', 150), file: CONTEXT_FILE },
          { ...feedback(9205, 180, 'ai'), file: CONTEXT_FILE }
        ]
      };
      await setup(page, mode, state);
      const wrapper = page.locator(`.context-file[data-file-name="${CONTEXT_FILE}"]`);
      const suggestion = wrapper.locator('.ai-suggestion[data-suggestion-id="9205"]');
      await expect(wrapper).toHaveCount(1);
      await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9204"]')).toBeVisible();
      await expect(wrapper.locator('tr[data-line-number="150"]')).toBeVisible();
      await expect(suggestion).toBeVisible();
      await expect(wrapper.locator('.user-comment-row[data-comment-id="9104"]')).toBeVisible();
      expect(state.contextAdds).toHaveLength(0);

      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(suggestion).toHaveCount(1);
      await expect(wrapper.locator('.user-comment-row[data-comment-id="9104"]')).toBeVisible();
      expect(state.contextAdds).toHaveLength(0);

      await wrapper.locator('.file-collapse-toggle').click();
      await expect(wrapper).toHaveClass(/collapsed/);
      await page.evaluate(() => window.aiPanel.expand());
      // Line 180 was revealed in place, outside the stored 10-30 window.
      // Jumping to it must reuse the rendered row, not store another window.
      await page.locator('.ai-panel .finding-item[data-id="9205"]').click();
      await expect(suggestion).toBeInViewport();
      expect(state.contextAdds).toHaveLength(0);
      await expect(wrapper.locator('.context-chunk')).toHaveCount(1);
      await expect(wrapper.locator('tr[data-line-number="180"]')).toHaveCount(1);

      // The render and every in-place reveal read the context file's working
      // tree; the diff file never asks for it.
      const readsOf = file => state.fileContentUrls.filter(url =>
        decodeURIComponent(url.pathname).endsWith(`/file-content/${file}`));
      expect(readsOf(CONTEXT_FILE).length).toBeGreaterThanOrEqual(2);
      expect(readsOf(CONTEXT_FILE).map(url => url.search)).toEqual(
        readsOf(CONTEXT_FILE).map(() => '?source=worktree'));
      expect(readsOf(FILE).filter(url => url.searchParams.has('source'))).toEqual([]);
    });

    test('suggestions expand existing context files without adding another entry', async ({ page }) => {
      const state = {
        comments: [],
        contextFiles: [{ id: 9400, file: CONTEXT_FILE, line_start: 10, line_end: 30 }],
        suggestions: [{ ...feedback(9206, 180, 'ai'), file: CONTEXT_FILE }]
      };
      await setup(page, mode, state);
      await expect(page.locator('.context-file .ai-suggestion[data-suggestion-id="9206"]')).toBeVisible();
      expect(state.contextAdds).toHaveLength(0);
    });

    test('file-level suggestions render in their server-created context file', async ({ page }) => {
      const state = {
        comments: [],
        contextFiles: [{ id: 9300, file: CONTEXT_FILE, line_start: 1, line_end: 50 }],
        suggestions: [{ ...feedback(9207, null, 'ai'), file: CONTEXT_FILE, is_file_level: 1 }]
      };
      await setup(page, mode, state);
      const card = page.locator('.context-file .ai-suggestion[data-suggestion-id="9207"]');
      await expect(card).toBeVisible();
      expect(state.contextAdds).toHaveLength(0);

      // Reloading user comments (save, restore, comments_changed) must not
      // clear the file-level AI cards.
      state.comments = [{ ...feedback(9111, null), file: CONTEXT_FILE, is_file_level: 1 }];
      await page.evaluate(() => window.prManager.loadUserComments());
      await expect(page.locator('.context-file .file-comment-card.user-comment[data-comment-id="9111"]')).toBeVisible();
      await expect(card).toBeVisible();
    });

    test('late context-file loading reanchors the selected run without creating rows', async ({ page }) => {
      let releaseContext;
      const state = {
        contextReady: new Promise(resolve => { releaseContext = resolve; }),
        contextFiles: [{ id: 9300, file: CONTEXT_FILE, line_start: 10, line_end: 30 }],
        comments: [],
        suggestions: [{ ...feedback(9208, 180, 'ai'), file: CONTEXT_FILE }],
        suggestionsByRun: {
          historical: [{ ...feedback(9210, 170, 'ai'), file: CONTEXT_FILE }]
        }
      };
      try {
        await setup(page, mode, state);
        const wrapper = page.locator(`.context-file[data-file-name="${CONTEXT_FILE}"]`);
        await expect(wrapper).toHaveCount(0);
        // Select an older run while context loading is blocked.
        await page.evaluate(async () => {
          window.prManager.selectedRunId = 'historical';
          await window.prManager.loadAISuggestions(null, 'historical');
        });
        releaseContext();
        await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9210"]')).toBeVisible();
        await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9208"]')).toHaveCount(0);
        await expect(wrapper.locator('.context-chunk')).toHaveCount(1);
        expect(state.contextAdds).toHaveLength(0);
      } finally {
        releaseContext();
      }
    });

    test('removing a context file stays removed across suggestion refreshes and reload', async ({ page }) => {
      const state = {
        contextFiles: [{ id: 9300, file: CONTEXT_FILE, line_start: 10, line_end: 30 }],
        comments: [],
        suggestions: [{ ...feedback(9209, 20, 'ai'), file: CONTEXT_FILE }]
      };
      await setup(page, mode, state);
      const wrapper = page.locator(`.context-file[data-file-name="${CONTEXT_FILE}"]`);
      await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9209"]')).toBeVisible();
      await wrapper.locator('.context-file-dismiss').click();
      await expect(wrapper).toHaveCount(0);
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(wrapper).toHaveCount(0);
      // Dismissed findings also must not recreate a removed wrapper.
      state.suggestions[0].status = 'dismissed';
      await page.reload();
      await page.waitForFunction(() => !!window.prManager?.analysisHistoryManager);
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(wrapper).toHaveCount(0);
      expect(state.contextAdds).toHaveLength(0);
    });

    for (const navigation of ['finding', 'comment', 'navigator']) {
      test(`clicking a ${navigation} restores a removed context file and scrolls to feedback`, async ({ page }) => {
        const state = {
          contextFiles: [{ id: 9300, file: CONTEXT_FILE, line_start: 10, line_end: 30 }],
          comments: [{ ...feedback(9110, 180), file: CONTEXT_FILE }],
          suggestions: [{ ...feedback(9213, 180, 'ai'), file: CONTEXT_FILE }]
        };
        await setup(page, mode, state);
        const wrapper = page.locator(`.context-file[data-file-name="${CONTEXT_FILE}"]`);
        await expect(wrapper.locator('.ai-suggestion[data-suggestion-id="9213"]')).toBeVisible();
        await wrapper.locator('.context-file-dismiss').click();
        await expect(wrapper).toHaveCount(0);
        await page.evaluate(() => window.prManager.loadAISuggestions());
        expect(state.contextAdds).toHaveLength(0);

        if (navigation === 'navigator') {
          await page.evaluate(() => {
            const navigator = window.prManager.suggestionNavigator;
            return navigator.goToSuggestion(navigator.suggestions.findIndex(item => item.id === 9213));
          });
        } else {
          await page.evaluate(() => window.aiPanel.expand());
          if (navigation === 'comment') {
            await page.locator('.ai-panel').getByRole('button', { name: 'User (1)', exact: true }).click();
          }
          await page.locator(`.ai-panel .finding-item[data-id="${navigation === 'comment' ? 9110 : 9213}"]`).click();
        }
        const target = navigation === 'comment'
          ? wrapper.locator('.user-comment-row[data-comment-id="9110"]')
          : wrapper.locator('.ai-suggestion[data-suggestion-id="9213"]');
        await expect(wrapper).toHaveCount(1);
        await expect(target).toBeInViewport();
        expect(state.contextAdds).toHaveLength(1);
      });
    }

    test('context loading queues a re-anchor while another suggestion render is in flight', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      state.suggestions = [
        { ...feedback(9211, 180, 'ai'), file: CONTEXT_FILE },
        feedback(9212, 180, 'ai')
      ];
      await page.evaluate(async () => {
        const manager = window.prManager;
        const ensure = manager.ensureLinesVisible;
        let release, ready;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { ready = resolve; });
        let blocked = false;
        manager.ensureLinesVisible = async function(items) {
          if (!blocked) {
            blocked = true;
            // The outside-diff file has no wrapper yet. Hold the render while
            // preparing its next file, after this first anchor was skipped.
            await ensure.call(this, items.slice(0, 1));
            ready();
            await gate;
            return ensure.call(this, items.slice(1));
          }
          return ensure.call(this, items);
        };
        window.contextRenderGate = {
          release,
          restore: () => { manager.ensureLinesVisible = ensure; },
          rendering: manager.loadAISuggestions()
        };
        await reached;
      });
      try {
        state.contextFiles = [{ id: 9300, file: CONTEXT_FILE, line_start: 10, line_end: 30 }];
        await page.evaluate(() => {
          window.contextRenderGate.contextLoading = window.prManager.loadContextFiles().then(() => {
            window.contextRenderGate.contextFinished = true;
            window.contextRenderGate.anchoredWhenFinished = !!document.querySelector(
              '.context-file .ai-suggestion[data-suggestion-id="9211"]'
            );
          });
        });
        await page.waitForFunction(() => window.prManager.suggestionManager._pendingSuggestions !== null);
        expect(await page.evaluate(() => window.prManager.suggestionManager._isDisplayingSuggestions)).toBe(true);
        expect(await page.evaluate(() => !!window.contextRenderGate.contextFinished)).toBe(false);
        await page.evaluate(async () => {
          window.contextRenderGate.release();
          await Promise.all([window.contextRenderGate.rendering, window.contextRenderGate.contextLoading]);
        });
        expect(await page.evaluate(() => window.contextRenderGate.anchoredWhenFinished)).toBe(true);
        await expect(page.locator('.context-file .ai-suggestion[data-suggestion-id="9211"]')).toBeVisible();
        await expect(inlineSuggestion(page, 9212)).toBeVisible();
      } finally {
        await page.evaluate(async () => {
          window.contextRenderGate.release();
          await Promise.all([window.contextRenderGate.rendering, window.contextRenderGate.contextLoading]);
          window.contextRenderGate.restore();
          delete window.contextRenderGate;
        });
      }
    });

    test('off-hunk comments remain visible when suggestions are refreshed', async ({ page }) => {
      const state = { comments: [feedback(9101, 20)], suggestions: [] };
      await setup(page, mode, state);
      await expect(inlineComment(page, 9101)).toBeVisible();

      state.suggestions = [feedback(9201, 180, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toBeVisible();
      await expect(inlineComment(page, 9101)).toBeVisible();

      // A second refresh must preserve the same two anchors without duplicates.
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9201)).toHaveCount(1);
      await expect(inlineComment(page, 9101)).toBeVisible();
    });

    test('comments on manually expanded lines survive another off-hunk anchor', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      await page.evaluate(async file => {
        await window.prManager._ensurePierreContentUpgrade(file);
        const { instance } = window.prManager.pierreBridge.files.get(file);
        instance.expandHunk(0, 'up', 85);
        instance.rerender();
      }, FILE);
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 85, 'RIGHT'), FILE)).toBe(true);

      state.comments = [feedback(9102, 85), feedback(9103, 180)];
      await page.evaluate(() => window.prManager.loadUserComments());
      await expect(inlineComment(page, 9102)).toBeVisible();
      await expect(inlineComment(page, 9103)).toBeVisible();
    });

    test('expanding a preceding gap does not hide a suggestion after the hunk', async ({ page }) => {
      const state = { comments: [], suggestions: [] };
      await setup(page, mode, state);
      const target = await page.evaluate(async file => {
        const manager = window.prManager;
        await manager._ensurePierreContentUpgrade(file);
        const instance = manager.pierreBridge.files.get(file).instance;
        const index = instance.fileDiff.hunks.findIndex(hunk =>
          hunk.additionStart <= 100 && hunk.additionStart + hunk.additionCount > 100);
        const hunk = instance.fileDiff.hunks[index];
        // Pierre's "down" direction reveals the END of the preceding gap.
        // It must not make lines following this hunk count as already visible.
        manager.pierreBridge.expandHunk(file, index, 'down', 5);
        return hunk.additionStart + hunk.additionCount + 1;
      }, FILE);

      state.suggestions = [feedback(9203, target, 'ai')];
      await page.evaluate(() => window.prManager.loadAISuggestions());
      await expect(inlineSuggestion(page, 9203)).toBeVisible();
      await page.evaluate(() => window.aiPanel.expand());
      await page.locator('.ai-panel .finding-item[data-id="9203"]').click();
      await expect(inlineSuggestion(page, 9203)).toBeInViewport();
    });

    test('suggestions spanning a visible hunk and hidden endpoint render and navigate', async ({ page }) => {
      const state = { comments: [], suggestions: [feedback(9202, 100, 'ai', 150)] };
      await setup(page, mode, state);
      const suggestion = inlineSuggestion(page, 9202);
      await expect(suggestion).toBeVisible();
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 150, 'RIGHT'), FILE)).toBe(true);

      // Rebuild from base metadata while retaining the annotation and durable
      // context ranges. Navigation must check the rows actually rendered.
      await page.evaluate(file => {
        const bridge = window.prManager.pierreBridge;
        const fileState = bridge.files.get(file);
        bridge._renderWithFileDiff(fileState, fileState.baseMetadata);
      }, FILE);
      await expect.poll(() => page.evaluate(file =>
        window.prManager.pierreBridge.isLineVisible(file, 150, 'RIGHT'), FILE)).toBe(false);
      await expect(suggestion).toBeHidden();

      // Collapse the file through the UI, then navigate to its range from
      // the sidebar to reveal the card again.
      const fileWrapper = page.locator(`.d2h-file-wrapper[data-file-name="${FILE}"]`);
      await fileWrapper.locator('.d2h-file-header').click();
      await expect(fileWrapper).toHaveClass(/collapsed/);
      await expect(suggestion).toBeHidden();
      // Use the actual sidebar click path to reveal the collapsed target again.
      await page.evaluate(() => window.aiPanel.expand());
      await page.evaluate(() => {
        const poolPrototype = window.PierreDiffs.WorkerPoolManager.prototype;
        const handleMessage = poolPrototype.handleWorkerMessage;
        const scroll = window.ScrollUtils.scrollIntoViewStable;
        const queued = [];
        let workerArrived;
        let scrollStarted;
        const workerReady = new Promise(resolve => { workerArrived = resolve; });
        const scrollReady = new Promise(resolve => { scrollStarted = resolve; });
        const gate = window.inlineNavigationGate = {
          completed: false,
          // Advance beyond the scroll helper's three-frame stability window
          // while the worker is blocked. This sentinel exposes an early finish
          // without relying on a machine-dependent delay.
          frames: Promise.all([workerReady, scrollReady]).then(async () => {
            for (let frame = 0; frame < 8; frame++) {
              await new Promise(requestAnimationFrame);
            }
          }),
          release() {
            poolPrototype.handleWorkerMessage = handleMessage;
            window.ScrollUtils.scrollIntoViewStable = scroll;
            for (const deliver of queued.splice(0)) deliver();
          }
        };
        poolPrototype.handleWorkerMessage = function(...args) {
          queued.push(() => handleMessage.apply(this, args));
          workerArrived();
        };
        window.ScrollUtils.scrollIntoViewStable = async (...args) => {
          scrollStarted();
          try {
            return await scroll(...args);
          } finally {
            gate.completed = true;
          }
        };
      });
      try {
        await page.locator('.ai-panel .finding-item[data-id="9202"]').click();
        await expect(fileWrapper).not.toHaveClass(/collapsed/);
        await page.evaluate(() => window.inlineNavigationGate.frames);
        await expect(suggestion).toBeHidden();
        expect(await page.evaluate(() => window.inlineNavigationGate.completed)).toBe(false);
        await page.evaluate(() => window.inlineNavigationGate.release());
        await expect(suggestion).toBeInViewport();
      } finally {
        await page.evaluate(() => {
          window.inlineNavigationGate.release();
          delete window.inlineNavigationGate;
        });
      }
    });
  });
}
