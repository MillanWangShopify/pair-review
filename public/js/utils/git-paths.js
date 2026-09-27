// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Git path spelling helpers for the browser.
 *
 * Git C-quotes any path containing a control character, `"`, `\`, or (with the
 * default core.quotePath=true) a byte >= 0x80: `café.js` appears in a
 * `diff --git` header as `"a/caf\303\251.js"`. The server decodes every path
 * it produces (src/utils/git-paths.js, src/utils/diff-file-content.js), and
 * comments, suggestions, and `data-file-name` are keyed by that decoded
 * spelling, so the diff parser here must decode headers identically.
 *
 * Mirrors `decodeGitPath` (src/utils/git-paths.js) and `parseDiffGitPaths`
 * (src/utils/diff-file-content.js). Both sides are tested against the shared
 * fixtures in tests/utils/git-path-fixtures.js; keep them in sync.
 */
(function () {
  const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"';
  const DIFF_GIT_PATHS_RE = new RegExp(`^(${QUOTED_PATH}|a\\/.+?) (${QUOTED_PATH}|b\\/.+)$`);
  const DECODE_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };

  /**
   * Decode a git C-quoted path (including octal-escaped UTF-8 bytes). An
   * unquoted value is returned unchanged: git always quotes a path that begins
   * with `"`, so a leading quote is unambiguous.
   * @param {string} value - Path as printed by git
   * @returns {string} Real path
   */
  function decodeGitPath(value) {
    if (!value.startsWith('"')) return value;
    const encoder = new TextEncoder();
    const bytes = [];
    for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
      if (match[2]) {
        bytes.push(...encoder.encode(match[2]));
      } else if (/^[0-7]/.test(match[1])) {
        bytes.push(parseInt(match[1], 8) & 0xff);
      } else {
        bytes.push(...encoder.encode(DECODE_ESCAPES[match[1]] ?? match[1]));
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }

  /**
   * Parse the old and new paths from a `diff --git` header line. Either side
   * may be C-quoted independently.
   * @param {string} headerLine - First line of a per-file patch
   * @returns {{ oldPath: string, newPath: string }|null} Decoded paths without
   *   their `a/` / `b/` prefixes, or null when the line is not a git header
   */
  function parseDiffGitPaths(headerLine) {
    if (!headerLine.startsWith('diff --git ')) return null;
    const match = headerLine.slice('diff --git '.length).match(DIFF_GIT_PATHS_RE);
    if (!match) return null;
    const oldPath = decodeGitPath(match[1]);
    const newPath = decodeGitPath(match[2]);
    if (!oldPath.startsWith('a/') || !newPath.startsWith('b/')) return null;
    return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
  }

  const GitPaths = { decodeGitPath, parseDiffGitPaths };

  if (typeof window !== 'undefined') {
    window.GitPaths = GitPaths;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GitPaths;
  }
})();
