// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const path = require('path');
const { queryOne, CommentRepository } = require('../database');
const { getDiffFileList, parseUnifiedDiffPatches } = require('./diff-file-list');
const { normalizeSuggestionPath, createChangedFilePredicate } = require('./changed-file-membership');
const { resolveRepoRoot } = require('./review-paths');
const { ensureContextFile } = require('./auto-context');
const { broadcastReviewEvent } = require('../events/review-events');
const logger = require('./logger');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('./line-validation');

const defaults = { fs };

/** Shared path check for every analysis stage and suggestion writer. */
function filterSuggestionPaths(suggestions, changedFiles, repoRoot, _deps) {
  const deps = { ...defaults, ..._deps };
  const isChanged = createChangedFilePredicate(changedFiles);
  const unverifiable = !isChanged.hasChangedFiles;
  if (unverifiable && suggestions?.length) {
    logger.warn('[FAILSAFE] Path validation bypassed: no changed files available; retaining safe relative paths and their supplied side.');
  }
  const exists = new Map();
  return (suggestions || []).flatMap(suggestion => {
    const file = normalizeSuggestionPath(suggestion?.file);
    const inDiff = file && isChanged(file);
    // An empty list may mean metadata lookup failed. Preserve the supplied side
    // even with a checkout: deleted changed files cannot be checked on disk.
    if (file && unverifiable) return [{ ...suggestion, file }];
    if (file && !inDiff && !exists.has(file)) {
      let isFile = false;
      if (repoRoot) {
        try {
          const root = deps.fs.realpathSync(repoRoot);
          const resolved = deps.fs.realpathSync(path.resolve(root, file));
          isFile = resolved.startsWith(root + path.sep) && deps.fs.statSync(resolved).isFile();
        } catch {
          // Missing files, directories and inaccessible paths cannot anchor feedback.
        }
      }
      exists.set(file, isFile);
    }
    if (!file || (!inDiff && !exists.get(file))) {
      logger.warn(`[FAILSAFE] Filtered AI suggestion with invalid path: "${suggestion?.file}"`);
      return [];
    }
    // Unchanged files have only a RIGHT side; their line numbers are raw file lines.
    return [{ ...suggestion, file, ...(!inDiff ? { old_or_new: 'NEW' } : {}) }];
  });
}

async function getSuggestionDiffFiles(db, review) {
  // Local imports persist the review's selected scope before saving findings.
  // Use that exact snapshot (including staged/branch changes and deletions),
  // also when refreshing it failed and the previous snapshot remains valid.
  // Without one, list the review's scope from git.
  const localDiff = review?.local_path
    ? await queryOne(db, 'SELECT diff_text FROM local_diffs WHERE review_id = ?', [review.id])
    : null;
  return localDiff
    ? [...parseUnifiedDiffPatches(localDiff.diff_text).keys()]
    : (review ? await getDiffFileList(db, review) : []);
}

/** Validate coordinates after admitting real files outside the changed-file list. */
async function validateAndFilterSuggestions(suggestions, changedFiles, fileLineCountMap = new Map(), repoRoot = null) {
  const filtered = filterSuggestionPaths(suggestions, changedFiles, repoRoot).map(suggestion => {
    if (suggestion.line !== undefined && suggestion.line_start === undefined) {
      return { ...suggestion, line_start: suggestion.line, line_end: suggestion.line_end ?? suggestion.line };
    }
    return suggestion;
  });
  // Checkout counts describe RIGHT/NEW. They cannot bound coordinates on the
  // old side of a changed file after lines were deleted. Off-diff findings were
  // already normalized to NEW by path validation and still need these checks.
  const isOldSide = suggestion => suggestion.old_or_new === 'OLD' ||
    (suggestion.old_or_new !== 'NEW' && suggestion.side === 'LEFT');
  const counts = new Map(fileLineCountMap);
  const missing = [...new Set(filtered.filter(suggestion => !isOldSide(suggestion))
    .map(suggestion => suggestion.file).filter(file => !counts.has(file)))];
  if (repoRoot && missing.length) {
    const additionalCounts = await buildFileLineCountMap(repoRoot, missing);
    for (const [file, count] of additionalCounts) counts.set(file, count);
  }
  const isChanged = createChangedFilePredicate(changedFiles);
  const offDiff = filtered.filter(suggestion => isChanged.hasChangedFiles && !isChanged(suggestion.file));
  const inDiff = filtered.filter(suggestion => !isChanged.hasChangedFiles || isChanged(suggestion.file));
  const unchangedResult = validateSuggestionLineNumbers(offDiff, counts, { convertToFileLevel: true });
  const oldSide = inDiff.filter(isOldSide);
  const oldResult = validateSuggestionLineNumbers(oldSide, counts, {
    convertToFileLevel: true, skipLengthCheck: true
  });
  const changedResult = validateSuggestionLineNumbers(inDiff.filter(suggestion => !isOldSide(suggestion)), counts, { convertToFileLevel: true });
  const retained = new Set([...oldResult.valid, ...changedResult.valid, ...unchangedResult.valid]);
  return [...filtered.filter(suggestion => retained.has(suggestion)),
    ...oldResult.converted, ...changedResult.converted, ...unchangedResult.converted];
}

/** Seed only the findings selected for display, never raw/intermediate analysis. */
async function seedContextFilesForSuggestions(db, reviewId, suggestions, options = {}) {
  const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
  if (!review) return false;
  const diffFiles = options.changedFiles ?? await getSuggestionDiffFiles(db, review);
  const isChanged = createChangedFilePredicate(diffFiles);
  if (!isChanged.hasChangedFiles) return false;
  const valid = options.validated ? suggestions
    : await validateAndFilterSuggestions(suggestions, diffFiles, new Map(), await resolveRepoRoot(db, review));
  let contextFilesChanged = false;
  const seeded = new Set();
  for (const suggestion of valid) {
    if (suggestion.status === 'dismissed' || isChanged(suggestion.file) || seeded.has(suggestion.file)) continue;
    seeded.add(suggestion.file);
    const result = await ensureContextFile(db, review, {
      file: suggestion.file,
      line_start: suggestion.line_start ?? suggestion.line,
      line_end: suggestion.line_end,
      label: 'Auto-added for suggestion',
      diffFiles,
      reuseFile: true
    });
    contextFilesChanged ||= result.created || result.expanded;
  }
  if (options.broadcast !== false && contextFilesChanged) {
    broadcastReviewEvent(reviewId, { type: 'review:context_files_changed' });
  }
  return contextFilesChanged;
}

/** Validate and store every stage; only final top-level output creates context. */
async function storeReviewSuggestions(db, {
  reviewId, runId, suggestions, level = null, changedFiles, insert, broadcast = true,
  seedContext = true, preparedSuggestions, fileLineCountMap, repoRoot
}) {
  const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
  // Import preparation already resolved even an unknown/empty diff before its
  // transaction; do not rerun a git fallback while that transaction is open.
  const diffFiles = preparedSuggestions !== undefined && changedFiles != null
    ? changedFiles
    : (changedFiles?.length ? changedFiles : await getSuggestionDiffFiles(db, review));
  // Prepared imports run inside a transaction; checkout resolution can perform
  // filesystem I/O, so only resolve it when validation still needs to run.
  const valid = preparedSuggestions ?? await validateAndFilterSuggestions(
    suggestions, diffFiles, fileLineCountMap || new Map(), repoRoot ?? await resolveRepoRoot(db, review)
  );
  if (insert) {
    await insert(valid);
  } else {
    await new CommentRepository(db).bulkInsertAISuggestions(reviewId, runId, valid, level);
  }
  let contextFilesChanged = false;
  if (seedContext && level === null) {
    const analysisRun = await queryOne(db, 'SELECT parent_run_id FROM analysis_runs WHERE id = ?', [runId]);
    if (!analysisRun?.parent_run_id) {
      contextFilesChanged = await seedContextFilesForSuggestions(db, reviewId, valid, { changedFiles: diffFiles, broadcast, validated: true });
    }
  }
  return { suggestions: valid, contextFilesChanged };
}

module.exports = {
  filterSuggestionPaths, validateAndFilterSuggestions,
  getSuggestionDiffFiles, seedContextFilesForSuggestions, storeReviewSuggestions
};
