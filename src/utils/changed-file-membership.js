// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The one "is this file part of the review's diff?" comparison. Every
 * membership check (suggestion validation, context-file seeding, comment
 * auto-context, the Local file-content source choice, GitHub submission)
 * normalizes both sides through `normalizeSuggestionPath`, so `./a.js`, `a.js`
 * and Git rename spellings of `a.js` all agree.
 */
const { normalizePath } = require('./paths');
const { isSafeRelativePath } = require('./review-paths');
const { mergeChangedFilesWithDiff } = require('./diff-file-list');

/** Resolve both Git rename forms before checking the destination path. */
function normalizeSuggestionPath(file) {
  if (!isSafeRelativePath(file)) return null;
  let resolved = file.replace(/\{[^}]*\s*=>\s*([^}]*)\}/g, '$1');
  if (resolved.includes(' => ')) resolved = resolved.split(' => ').pop().trim();
  return isSafeRelativePath(resolved) ? normalizePath(resolved) : null;
}

/**
 * Match canonical changed-file paths, including renamed destinations.
 * @param {Array<object|string>} changedFiles - changed_files entries or paths
 * @param {string} [diff] - Full unified diff; recovers entries missing from changedFiles
 * @returns {(file: string) => string|null} Resolver returning the normalized
 *   changed path, or null; `.hasChangedFiles` is false for an empty list
 */
function createChangedFilePredicate(changedFiles, diff = '') {
  const files = diff
    ? mergeChangedFilesWithDiff(changedFiles, diff)
    : (Array.isArray(changedFiles) ? changedFiles : []);
  const paths = new Set(files.map(entry =>
    normalizeSuggestionPath(typeof entry === 'string' ? entry : entry?.file)
  ).filter(Boolean));
  const resolve = file => {
    const normalized = normalizeSuggestionPath(file);
    return normalized && paths.has(normalized) ? normalized : null;
  };
  resolve.hasChangedFiles = paths.size > 0;
  return resolve;
}

module.exports = { normalizeSuggestionPath, createChangedFilePredicate };
