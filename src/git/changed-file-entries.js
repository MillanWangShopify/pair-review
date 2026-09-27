// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { parseNumstatPath } = require('../utils/git-paths');

/**
 * Convert simple-git `diffSummary` (--numstat) files into PR `changed_files`
 * entries. Paths are decoded from git's C-quoted spelling and rename syntax so
 * they match the paths parsed from the unified diff's `diff --git` headers.
 *
 * @param {Array<object>} files - `diffSummary(...).files`
 * @param {{ isGenerated: (file: string) => boolean }} gitattributes - Generated-file matcher
 * @returns {Array<object>} changed_files entries
 */
function buildChangedFileEntries(files, gitattributes) {
  return files.map(file => {
    const { file: resolvedFile, renamedFrom } = parseNumstatPath(file.file);
    const result = {
      file: resolvedFile,
      insertions: file.insertions,
      deletions: file.deletions,
      changes: file.changes,
      binary: file.binary || false,
      generated: gitattributes.isGenerated(resolvedFile)
    };
    if (renamedFrom !== null) {
      result.renamed = true;
      result.renamedFrom = renamedFrom;
    }
    return result;
  });
}

module.exports = { buildChangedFileEntries };
