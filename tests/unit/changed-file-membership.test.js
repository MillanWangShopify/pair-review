// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
const { createChangedFilePredicate, normalizeSuggestionPath } = require('../../src/utils/changed-file-membership');

describe('changed file membership for review submission', () => {
  it('matches normalized renamed destinations and rejects unchanged or unsafe paths', () => {
    const contains = createChangedFilePredicate([{ file: 'src/{old.js => new.js}' }]);
    expect(contains('./src/new.js')).toBe('src/new.js');
    expect(contains('src/old.js')).toBeNull();
    expect(contains('../src/new.js')).toBeNull();
    expect(contains(null)).toBeNull();
  });

  it('recovers paths from the diff when metadata is missing or abbreviated', () => {
    const contains = createChangedFilePredicate([{ file: 'src/.../file.js' }],
      'diff --git a/src/full/path/file.js b/src/full/path/file.js\n--- a/src/full/path/file.js\n+++ b/src/full/path/file.js\n');
    expect(contains('src/full/path/file.js')).toBe('src/full/path/file.js');
    expect(contains('src/.../file.js')).toBeNull();
    expect(createChangedFilePredicate(null)('file.js')).toBeNull();
  });

  it('matches plain path lists without a diff', () => {
    const contains = createChangedFilePredicate(['a.js', './b.js', 'c/{x => y}.js']);
    expect(contains('./a.js')).toBe('a.js');
    expect(contains('b.js')).toBe('b.js');
    expect(contains('c/y.js')).toBe('c/y.js');
    expect(contains('d.js')).toBeNull();
    expect(createChangedFilePredicate([]).hasChangedFiles).toBe(false);
  });
});

describe('normalizeSuggestionPath', () => {
  it('resolves Git rename spellings to the destination and rejects unsafe paths', () => {
    expect(normalizeSuggestionPath('src/{old.js => new.js}')).toBe('src/new.js');
    expect(normalizeSuggestionPath('old.js => new.js')).toBe('new.js');
    expect(normalizeSuggestionPath('./src/a.js')).toBe('src/a.js');
    expect(normalizeSuggestionPath('../a.js')).toBeNull();
    expect(normalizeSuggestionPath('/abs.js')).toBeNull();
    expect(normalizeSuggestionPath(undefined)).toBeNull();
  });
});
