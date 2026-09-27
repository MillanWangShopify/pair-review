// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The browser decoder must spell every path exactly as the server does, so it
// runs the server's fixtures (tests/unit/git-paths.test.js,
// tests/unit/diff-file-content.test.js) and is compared against the server
// implementation directly.
const GitPaths = require('../../public/js/utils/git-paths.js');
const serverGitPaths = require('../../src/utils/git-paths');
const { parseDiffGitPaths: serverParseDiffGitPaths } = require('../../src/utils/diff-file-content');
const { parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list');
const {
  DECODE_CASES,
  DIFF_HEADER_CASES,
  MALFORMED_DIFF_HEADERS
} = require('../utils/git-path-fixtures');

// Verbatim git output (core.quotePath=true): a quoted modification, a rename
// into a quoted destination whose paths share nothing, and a plain file.
const QUOTED_DIFF = [
  String.raw`diff --git "a/src/caf\303\251.js" "b/src/caf\303\251.js"`,
  'index 1111111..2222222 100644',
  String.raw`--- "a/src/caf\303\251.js"`,
  String.raw`+++ "b/src/caf\303\251.js"`,
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"`,
  'similarity index 80%',
  'rename from lib/moved.js',
  String.raw`rename to "\303\261ew dir/moved \303\251.js"`,
  'index 3333333..4444444 100644',
  '--- a/lib/moved.js',
  String.raw`+++ "b/\303\261ew dir/moved \303\251.js"` + '\t',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/plain.js b/plain.js',
  'index 5555555..6666666 100644',
  '--- a/plain.js',
  '+++ b/plain.js',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  ''
].join('\n');

describe('GitPaths.decodeGitPath (browser)', () => {
  it.each(DECODE_CASES)('decodes %s', (raw, decoded) => {
    expect(GitPaths.decodeGitPath(raw)).toBe(decoded);
    expect(GitPaths.decodeGitPath(raw)).toBe(serverGitPaths.decodeGitPath(raw));
  });

  it('decodes everything the server quotes', () => {
    for (const name of ['café.js', 'naïve/ünt.js', 'tab\tname', 'quo"te', 'back\\slash', 'nl\nname', '日本語.txt', 'emoji-😀.md']) {
      expect(GitPaths.decodeGitPath(serverGitPaths.quoteGitPath(name))).toBe(name);
    }
  });
});

describe('GitPaths.parseDiffGitPaths (browser)', () => {
  it.each(DIFF_HEADER_CASES)('parses %s', (header, oldPath, newPath) => {
    expect(GitPaths.parseDiffGitPaths(header)).toEqual({ oldPath, newPath });
    expect(GitPaths.parseDiffGitPaths(header)).toEqual(serverParseDiffGitPaths(header));
  });

  it.each(MALFORMED_DIFF_HEADERS)('rejects %s', header => {
    expect(GitPaths.parseDiffGitPaths(header)).toBeNull();
    expect(serverParseDiffGitPaths(header)).toBeNull();
  });
});

describe('PRManager.parseUnifiedDiff', () => {
  // PRManager is browser code; load it in a vm sandbox (see
  // pr-manager-diff-view.test.js) with the real GitPaths module installed the
  // way pr.html / local.html install it.
  function loadPRManager() {
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/pr.js'), 'utf8');
    const sandbox = {
      document: { addEventListener() {} },
      console,
      localStorage: { getItem() { return null; }, setItem() {} },
      fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
      navigator: { clipboard: {} },
      setTimeout,
      clearTimeout,
      URLSearchParams,
      GitPaths,
      module: { exports: {} }
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    vm.runInContext(code, vm.createContext(sandbox), { filename: 'pr.js' });
    return sandbox.module.exports.PRManager;
  }

  it('keys patches by the decoded new path, matching the server', () => {
    const PRManager = loadPRManager();
    const patches = PRManager.prototype.parseUnifiedDiff.call({}, QUOTED_DIFF);

    expect([...patches.keys()]).toEqual(['src/café.js', 'ñew dir/moved é.js', 'plain.js']);
    expect([...patches.keys()]).toEqual([...parseUnifiedDiffPatches(QUOTED_DIFF).keys()]);
    expect(patches.get('src/café.js')).toMatch(/^diff --git "a\/src\/caf\\303\\251\.js"/);
    expect(patches.get('plain.js')).toContain('+b');
  });

  it('returns an empty map for an empty diff', () => {
    const PRManager = loadPRManager();
    expect(PRManager.prototype.parseUnifiedDiff.call({}, '').size).toBe(0);
  });
});

describe('PierreBridge.parsePatch', () => {
  const BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';
  let parsePatchFiles;

  beforeAll(async () => {
    // The real @pierre/diffs parser (the vendor bundle is built from it).
    ({ parsePatchFiles } = await import('../../node_modules/@pierre/diffs/dist/utils/parsePatchFiles.js'));
  });

  function loadBridge() {
    delete require.cache[require.resolve(BRIDGE_PATH)];
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.document = dom.window.document;
    global.window = {
      PierreDiffs: { parsePatchFiles, getSingularPatch: () => null },
      GitPaths,
      matchMedia: () => ({ matches: false })
    };
    global.requestAnimationFrame = () => {};
    const PierreBridge = require(BRIDGE_PATH);
    return new PierreBridge({});
  }

  afterEach(() => {
    delete global.window;
    delete global.document;
    delete global.requestAnimationFrame;
  });

  it('reports decoded names for a C-quoted modification', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(QUOTED_DIFF).get('src/café.js');

    // Pierre on its own keeps git's escapes.
    expect(parsePatchFiles(patch)[0].files[0].name).toBe(String.raw`src/caf\303\251.js`);

    const metadata = bridge.parsePatch(patch);
    expect(metadata.name).toBe('src/café.js');
    expect(metadata.prevName).toBeUndefined();
    expect(metadata.hunks).toHaveLength(1);
  });

  it('reports decoded new and old names for a rename into a quoted path', () => {
    const bridge = loadBridge();
    const patch = parseUnifiedDiffPatches(QUOTED_DIFF).get('ñew dir/moved é.js');

    // Pierre on its own reports the OLD path as the name here: the unquoted
    // `--- a/` line overwrites the quoted `rename to`.
    expect(parsePatchFiles(patch)[0].files[0].name).toBe('lib/moved.js');

    const metadata = bridge.parsePatch(patch);
    expect(metadata.name).toBe('ñew dir/moved é.js');
    expect(metadata.prevName).toBe('lib/moved.js');
  });

  it('leaves bare hunk content to the caller-supplied name', () => {
    const bridge = loadBridge();
    const metadata = bridge.parsePatch('@@ -1 +1 @@\n-a\n+b\n');
    expect(metadata.name).toBe('file');
    expect(metadata.hunks).toHaveLength(1);
  });
});
