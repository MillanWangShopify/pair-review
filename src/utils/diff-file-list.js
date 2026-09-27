// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { queryOne } = require('../database');
const { listScopedChangedFiles } = require('../git/scoped-changed-files');
const { reviewScope } = require('../local-scope');
const { normalizePath, resolveRenamedFile } = require('./paths');
const { parseDiffGitPaths } = require('./diff-file-content');
const { decodeGitPath, parseNumstatPath } = require('./git-paths');
const { parseHunkHeader } = require('./diff-annotator');

/**
 * Parse a unified diff into a map of file path -> per-file patch.
 * Uses the "b/" path from the diff header as the canonical file path.
 *
 * @param {string} diff - Full unified diff
 * @returns {Map<string, string>} Map of file paths to full patch text
 */
function parseUnifiedDiffPatches(diff) {
  const filePatchMap = new Map();
  if (!diff) return filePatchMap;

  const parts = diff.split(/(?=^diff --git )/m);

  for (const part of parts) {
    if (!part.trim()) continue;

    const paths = parseDiffGitPaths(part.split('\n', 1)[0]);
    if (paths) {
      filePatchMap.set(paths.newPath, part);
    }
  }

  return filePatchMap;
}

/**
 * Count additions and deletions inside a single patch body.
 *
 * Only lines inside a hunk count: after an `@@` header and within the line
 * counts it declares. A prefix test cannot tell headers from content — a
 * deleted `-- x` line is emitted as `--- x` and an added `++ x` as `+++ x` —
 * but hunk state can: `---`/`+++` are headers only outside a hunk (the same
 * rule `buildDiffLineSet` in diff-annotator.js follows).
 *
 * @param {string} patch - Per-file patch text
 * @returns {{ insertions: number, deletions: number }}
 */
function countPatchStats(patch) {
  let insertions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of patch.split('\n')) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldRemaining = hunk.oldCount;
      newRemaining = hunk.newCount;
    } else if (line.startsWith('+') && newRemaining > 0) {
      insertions++;
      newRemaining--;
    } else if (line.startsWith('-') && oldRemaining > 0) {
      deletions++;
      oldRemaining--;
    } else if (line.startsWith(' ')) {
      oldRemaining--;
      newRemaining--;
    }
  }

  return { insertions, deletions };
}

const renamePairKey = (file, renamedFrom) => `${renamedFrom}\0${file}`;

/**
 * Index diff paths whose literal names numstat would misread as a rename:
 * a real file named `a => b.md` or `src/{a => b}.md` is printed unquoted, so
 * it parses as a rename of `a` to `b.md`. Keyed by that misread pair.
 *
 * @param {Map<string, string>} patchMap - Decoded diff paths
 * @returns {Map<string, string>} Misread rename pair -> literal diff path
 */
function indexRenameLookalikePaths(patchMap) {
  const lookalikes = new Map();
  for (const filePath of patchMap.keys()) {
    const { file, renamedFrom } = parseNumstatPath(filePath);
    if (renamedFrom !== null) lookalikes.set(renamePairKey(file, renamedFrom), filePath);
  }
  return lookalikes;
}

/**
 * Re-spell a changed_files entry so it matches the diff headers:
 *   - one cached before numstat paths were decoded (e.g. `"caf\303\251.js"`
 *     or `a.js => "b\303\251.js"`); the decoded spelling is adopted only when
 *     the diff confirms it, so a decoded name that merely looks quoted is
 *     never mangled;
 *   - a decoded "rename" that was really a file literally named like one
 *     (`a => b.md`): the diff has the literal path and not the destination,
 *     so the entry becomes that literal path with no rename.
 *
 * @param {object|string} entry - changed_files entry
 * @param {Map<string, string>} patchMap - Decoded diff paths
 * @param {Map<string, string>} lookalikes - From indexRenameLookalikePaths
 * @returns {object|string} Entry spelled like the diff headers
 */
function respellEntry(entry, patchMap, lookalikes) {
  const filePath = typeof entry === 'string' ? entry : entry.file;
  if (typeof entry !== 'string' && entry.renamedFrom && !patchMap.has(filePath)) {
    const literal = lookalikes.get(renamePairKey(filePath, entry.renamedFrom));
    if (literal) {
      const respelled = { ...entry, file: literal };
      delete respelled.renamed;
      delete respelled.renamedFrom;
      return respelled;
    }
  }
  const { file, renamedFrom } = parseNumstatPath(filePath);
  if (file === filePath || !patchMap.has(file)) return entry;
  if (typeof entry === 'string') return file;
  return renamedFrom
    ? { ...entry, file, renamed: true, renamedFrom }
    : { ...entry, file };
}

/**
 * Merge changed_files metadata with the authoritative file list from the diff.
 * This recovers files when cached changed_files were derived from abbreviated
 * diff --stat output and no longer match the full patch headers.
 *
 * @param {Array<object|string>} changedFiles - Existing changed_files array
 * @param {string} diff - Full unified diff
 * @returns {Array<object|string>} Merged changed_files array
 */
function mergeChangedFilesWithDiff(changedFiles, diff) {
  const patchMap = parseUnifiedDiffPatches(diff);
  if (patchMap.size === 0) {
    return Array.isArray(changedFiles) ? changedFiles : [];
  }

  const lookalikes = indexRenameLookalikePaths(patchMap);

  // Drop cached `git diff --stat` ellipsis stubs once we have authoritative
  // patch headers to recover the full file paths from.
  const existing = (Array.isArray(changedFiles) ? changedFiles : []).filter(entry => {
    const filePath = typeof entry === 'string' ? entry : entry?.file;
    return filePath && !filePath.includes('...');
  }).map(entry => respellEntry(entry, patchMap, lookalikes));

  const normalizedExisting = new Set(existing.map(file => {
    const filePath = typeof file === 'string' ? file : file?.file;
    return normalizePath(resolveRenamedFile(filePath));
  }).filter(Boolean));

  const merged = [...existing];

  for (const [filePath, patch] of patchMap.entries()) {
    const normalizedPatchPath = normalizePath(resolveRenamedFile(filePath));
    if (normalizedExisting.has(normalizedPatchPath)) {
      continue;
    }

    const { insertions, deletions } = countPatchStats(patch);
    const renameFrom = decodeGitPath(patch.match(/^rename from (.+)$/m)?.[1] ?? '') || null;
    const renameTo = decodeGitPath(patch.match(/^rename to (.+)$/m)?.[1] ?? '') || null;
    const binary = /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

    merged.push({
      file: filePath,
      insertions,
      deletions,
      changes: insertions + deletions,
      binary,
      renamed: Boolean(renameFrom && renameTo),
      renamedFrom: renameFrom
    });
    normalizedExisting.add(normalizedPatchPath);
  }

  return merged;
}

/**
 * Return the list of file paths that belong to the review's diff.
 * Works for both PR-mode and local-mode reviews.
 *
 * @param {object} db   - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string[]>} Array of relative file paths in the diff
 */
async function getDiffFileList(db, review) {
  // PR mode – pull from pr_metadata table
  if (review.pr_number && review.repository) {
    try {
      const prRecord = await queryOne(db, `
        SELECT pr_data FROM pr_metadata
        WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      `, [review.pr_number, review.repository]);

      if (prRecord?.pr_data) {
        const prData = JSON.parse(prRecord.pr_data);
        return mergeChangedFilesWithDiff(prData.changed_files || [], prData.diff || '')
          .map(f => typeof f === 'string' ? f : f.file)
          .filter(Boolean);
      }
    } catch {
      // parse / query error – fall through to empty list
    }
    return [];
  }

  // Local mode – ask git for the files within the review's selected scope
  // (staged/branch included when selected), not just unstaged + untracked.
  if (review.local_path) {
    try {
      const { start, end } = reviewScope(review);
      return await listScopedChangedFiles(review.local_path, {
        scopeStart: start, scopeEnd: end, baseBranch: review.local_base_branch
      });
    } catch {
      // git error – fall through to empty list
    }
    return [];
  }

  return [];
}

module.exports = {
  getDiffFileList,
  parseUnifiedDiffPatches,
  countPatchStats,
  mergeChangedFilesWithDiff
};
