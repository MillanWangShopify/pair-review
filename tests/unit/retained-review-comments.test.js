// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
const { PRManager } = require('../../public/js/pr');

afterEach(() => { document.body.innerHTML = ''; });

describe('comments retained after review submission', () => {
  it('lists comments safely outside the diff and supports dismissal', () => {
    document.body.innerHTML = '<main><div id="diff-container"></div></main>';
    const manager = Object.create(PRManager.prototype);
    manager.showRetainedCommentsNotice([{ file: 'helper.js', line_start: 10, line_end: 12, body: '<script>bad()</script>' }]);
    const notice = document.getElementById('retained-review-comments');
    expect(notice.textContent).toContain('1 comment kept in pair-review');
    expect(notice.textContent).toContain('helper.js:10–12');
    expect(notice.textContent).toContain('<script>bad()</script>');
    expect(notice.querySelector('script')).toBeNull();
    notice.querySelector('button').click();
    expect(document.getElementById('retained-review-comments')).toBeNull();
    manager.showRetainedCommentsNotice([{ file: 'helper.js', body: 'Remaining feedback' }]);
    manager.showRetainedCommentsNotice([]);
    expect(document.getElementById('retained-review-comments')).toBeNull();
  });

  it('handles file-level comments and pages without a diff', () => {
    const manager = Object.create(PRManager.prototype);
    expect(() => manager.showRetainedCommentsNotice([{ file: 'helper.js' }])).not.toThrow();
    document.body.innerHTML = '<div id="diff-container"></div>';
    manager.showRetainedCommentsNotice([{ file: 'helper.js', line_start: null, body: 'File feedback' }]);
    expect(document.querySelector('#retained-review-comments strong').textContent).toBe('helper.js');
  });
});
