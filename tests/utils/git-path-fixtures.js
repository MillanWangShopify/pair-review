// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared git path spelling fixtures.
 *
 * The server (src/utils/git-paths.js, src/utils/diff-file-content.js) and the
 * browser (public/js/utils/git-paths.js) each decode git's C-quoted paths.
 * Both test suites run these same cases so the two decoders cannot drift.
 *
 * Quoted strings are verbatim `git -c core.quotePath=true` output captured
 * from a real repository (git 2.x).
 */

/** [git spelling, decoded path] */
const DECODE_CASES = [
  ['src/plain.js', 'src/plain.js'],
  ['dir with space/a b.js', 'dir with space/a b.js'],
  [String.raw`"caf\303\251.js"`, 'café.js'],
  [String.raw`"dir/m\303\266v\303\251d.js"`, 'dir/mövéd.js'],
  [String.raw`"\346\227\245\346\234\254\350\252\236.txt"`, '日本語.txt'],
  [String.raw`"emoji-\360\237\230\200.md"`, 'emoji-😀.md'],
  [String.raw`"src/tab\tname.js"`, 'src/tab\tname.js'],
  [String.raw`"nl\nname"`, 'nl\nname'],
  [String.raw`"quo\"te.js"`, 'quo"te.js'],
  [String.raw`"back\\slash.js"`, 'back\\slash.js'],
  [String.raw`"del\177.js"`, 'del\x7f.js'],
  [String.raw`"ctl\001.js"`, 'ctl\x01.js'],
  // A byte sequence that is not valid UTF-8 decodes to U+FFFD on both sides.
  [String.raw`"bad\377.js"`, 'bad�.js']
];

/** [diff --git header, decoded old path, decoded new path] */
const DIFF_HEADER_CASES = [
  ['diff --git a/src/file.js b/src/file.js', 'src/file.js', 'src/file.js'],
  ['diff --git a/a b.js b/c d.js', 'a b.js', 'c d.js'],
  ['diff --git "a/src/file name.js" "b/src/file name.js"', 'src/file name.js', 'src/file name.js'],
  [String.raw`diff --git "a/caf\303\251.js" "b/caf\303\251.js"`, 'café.js', 'café.js'],
  [String.raw`diff --git "a/caf\303\251.js" b/cafe.js`, 'café.js', 'cafe.js'],
  [String.raw`diff --git a/cafe.js "b/caf\303\251.js"`, 'cafe.js', 'café.js'],
  [String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"`, 'lib/moved.js', 'ñew dir/moved é.js'],
  [String.raw`diff --git "a/a\"b\\c.js" "b/a\"b\\c.js"`, 'a"b\\c.js', 'a"b\\c.js'],
  [String.raw`diff --git "a/a\tb.js" "b/a\tb.js"`, 'a\tb.js', 'a\tb.js']
];

/** Lines that are not parseable `diff --git` headers. */
const MALFORMED_DIFF_HEADERS = [
  'invalid',
  'diff --git "a/bad.js b/bad.js',
  'diff --git x/file.js b/file.js',
  String.raw`diff --git "x/caf\303\251.js" "b/caf\303\251.js"`
];

module.exports = {
  DECODE_CASES,
  DIFF_HEADER_CASES,
  MALFORMED_DIFF_HEADERS
};
