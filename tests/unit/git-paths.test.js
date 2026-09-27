// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  decodeGitPath,
  quoteGitPath,
  splitGitPathLines,
  decodeDiffLinePath,
  parseNumstatPath
} = require('../../src/utils/git-paths');

const { DECODE_CASES } = require('../utils/git-path-fixtures');

// Fixture strings below are verbatim `git -c core.quotePath=true` output
// captured from a real repository (git 2.x). DECODE_CASES is shared with the
// browser decoder's test (tests/unit/frontend-git-paths.test.js).
describe('decodeGitPath', () => {
  it.each(DECODE_CASES)('decodes %s', (raw, decoded) => {
    expect(decodeGitPath(raw)).toBe(decoded);
  });

  it('agrees with quoteGitPath on every valid shared fixture', () => {
    for (const [raw, decoded] of DECODE_CASES) {
      if (decoded.includes('\ufffd')) continue;
      expect(quoteGitPath(decoded)).toBe(raw);
    }
  });
});

describe('quoteGitPath', () => {
  it('leaves paths that git does not quote unchanged', () => {
    expect(quoteGitPath('b/src/plain.js')).toBe('b/src/plain.js');
    expect(quoteGitPath('b/dir with space/a b.js')).toBe('b/dir with space/a b.js');
    expect(quoteGitPath('b/$weird{}[].js')).toBe('b/$weird{}[].js');
  });

  it('quotes exactly as git does with core.quotePath=true', () => {
    expect(quoteGitPath('b/café.js')).toBe(String.raw`"b/caf\303\251.js"`);
    expect(quoteGitPath('b/src/tab\tname.js')).toBe(String.raw`"b/src/tab\tname.js"`);
    expect(quoteGitPath('b/quo"te.js')).toBe(String.raw`"b/quo\"te.js"`);
    expect(quoteGitPath('b/back\\slash.js')).toBe(String.raw`"b/back\\slash.js"`);
    expect(quoteGitPath('b/del\x7f.js')).toBe(String.raw`"b/del\177.js"`);
    expect(quoteGitPath('b/ctl\x01.js')).toBe(String.raw`"b/ctl\001.js"`);
  });

  it('round-trips through decodeGitPath', () => {
    for (const name of ['café.js', 'naïve/ünt.js', 'tab\tname', 'quo"te', 'back\\slash', 'nl\nname', '日本語.txt']) {
      expect(decodeGitPath(quoteGitPath(name))).toBe(name);
    }
  });
});

describe('splitGitPathLines', () => {
  it('splits and decodes --name-only / ls-files output', () => {
    const stdout = [
      String.raw`"caf\303\251.js"`,
      String.raw`"dir/m\303\266v\303\251d.js"`,
      'src/plain.js',
      String.raw`"src/tab\tname.js"`,
      ''
    ].join('\n');
    expect(splitGitPathLines(stdout)).toEqual(['café.js', 'dir/mövéd.js', 'src/plain.js', 'src/tab\tname.js']);
  });

  it('returns an empty list for empty or missing output', () => {
    expect(splitGitPathLines('')).toEqual([]);
    expect(splitGitPathLines('\n')).toEqual([]);
    expect(splitGitPathLines(undefined)).toEqual([]);
  });
});

describe('decodeDiffLinePath', () => {
  it('decodes ---/+++ paths and strips the side prefix', () => {
    expect(decodeDiffLinePath('a/src/plain.js', 'a/')).toBe('src/plain.js');
    expect(decodeDiffLinePath(String.raw`"b/caf\303\251.js"`, 'b/')).toBe('café.js');
  });

  it('drops the tab git appends after a path containing a space', () => {
    expect(decodeDiffLinePath('b/a b.js\t', 'b/')).toBe('a b.js');
    expect(decodeDiffLinePath(String.raw`"b/nouveau \303\251.txt"` + '\t', 'b/')).toBe('nouveau é.txt');
  });

  it('returns null for /dev/null', () => {
    expect(decodeDiffLinePath('/dev/null', 'a/')).toBeNull();
  });

  it('decodes rename from/to paths, which carry no prefix', () => {
    expect(decodeDiffLinePath(String.raw`"\303\261ew dir/moved \303\251.js"`)).toBe('ñew dir/moved é.js');
    expect(decodeDiffLinePath('lib/moved.js')).toBe('lib/moved.js');
  });
});

describe('parseNumstatPath', () => {
  it('decodes a single quoted path', () => {
    expect(parseNumstatPath(String.raw`"caf\303\251.js"`)).toEqual({ file: 'café.js', renamedFrom: null });
    expect(parseNumstatPath(String.raw`"quo\"te.js"`)).toEqual({ file: 'quo"te.js', renamedFrom: null });
  });

  it('passes a plain path through', () => {
    expect(parseNumstatPath('src/plain.js')).toEqual({ file: 'src/plain.js', renamedFrom: null });
  });

  it('resolves brace-compacted renames (neither side quoted)', () => {
    expect(parseNumstatPath('src/{old.js => new.js}')).toEqual({ file: 'src/new.js', renamedFrom: 'src/old.js' });
    expect(parseNumstatPath('{old-dir => new-dir}/file.js')).toEqual({ file: 'new-dir/file.js', renamedFrom: 'old-dir/file.js' });
    // core.quotePath=false leaves UTF-8 raw, so git brace-compacts it.
    expect(parseNumstatPath('dïr3/{sub.js => süb.js}')).toEqual({ file: 'dïr3/süb.js', renamedFrom: 'dïr3/sub.js' });
  });

  it('resolves full renames where only the destination is quoted', () => {
    expect(parseNumstatPath(String.raw`dir/moved.js => "dir/m\303\266v\303\251d.js"`))
      .toEqual({ file: 'dir/mövéd.js', renamedFrom: 'dir/moved.js' });
    expect(parseNumstatPath(String.raw`lib/x.js => "l\303\257b/x.js"`))
      .toEqual({ file: 'lïb/x.js', renamedFrom: 'lib/x.js' });
  });

  it('resolves full renames where both sides are quoted independently', () => {
    expect(parseNumstatPath(String.raw`"d\303\257r3/sub.js" => "d\303\257r3/s\303\274b.js"`))
      .toEqual({ file: 'dïr3/süb.js', renamedFrom: 'dïr3/sub.js' });
    expect(parseNumstatPath(String.raw`"quo\"te.js" => "lib-quo\"te.js"`))
      .toEqual({ file: 'lib-quo"te.js', renamedFrom: 'quo"te.js' });
  });

  it('resolves unquoted renames that share no prefix or suffix (no braces)', () => {
    expect(parseNumstatPath('src/plain.js => top.js')).toEqual({ file: 'top.js', renamedFrom: 'src/plain.js' });
  });

  it('handles empty input', () => {
    expect(parseNumstatPath('')).toEqual({ file: '', renamedFrom: null });
    expect(parseNumstatPath(undefined)).toEqual({ file: undefined, renamedFrom: null });
  });
});
