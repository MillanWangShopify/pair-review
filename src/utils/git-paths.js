// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Git path spelling helpers.
 *
 * Git C-quotes any path containing a control character, `"`, `\`, or (with the
 * default core.quotePath=true) a byte >= 0x80: `café.js` is printed as
 * `"caf\303\251.js"` by `diff --git` headers, `--numstat`, `--name-only` and
 * `ls-files`. Every producer of changed-file paths decodes through this module
 * so the server holds exactly one spelling of each path: the real filename.
 */
const { resolveRenamedFile, resolveRenamedFileOld } = require('./paths');

const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"';
const QUOTED_ONLY_RE = new RegExp(`^${QUOTED_PATH}$`);
const ARROW_RENAME_RE = new RegExp(`^(${QUOTED_PATH}|.+?) => (${QUOTED_PATH}|.+)$`);

const DECODE_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
const ENCODE_ESCAPES = { 0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x22: '"', 0x5c: '\\' };

/**
 * Decode a git C-quoted path (including octal-escaped UTF-8 bytes). An
 * unquoted value is returned unchanged: git always quotes a path that begins
 * with `"`, so a leading quote is unambiguous.
 * @param {string} value - Path as printed by git
 * @returns {string} Real path
 */
function decodeGitPath(value) {
  if (!value.startsWith('"')) return value;
  const chunks = [];
  for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
    if (match[2]) {
      chunks.push(Buffer.from(match[2]));
    } else if (/^[0-7]/.test(match[1])) {
      chunks.push(Buffer.from([parseInt(match[1], 8)]));
    } else {
      chunks.push(Buffer.from(DECODE_ESCAPES[match[1]] ?? match[1]));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Quote a path exactly as git does with the default core.quotePath=true, so a
 * header we synthesize is spelled like one git would print. Paths that need no
 * quoting are returned unchanged.
 * @param {string} value - Real path (may include an `a/` or `b/` prefix)
 * @returns {string} Git-spelled path
 */
function quoteGitPath(value) {
  const bytes = Buffer.from(value, 'utf8');
  let needsQuote = false;
  let out = '';
  for (const byte of bytes) {
    if (ENCODE_ESCAPES[byte] !== undefined) {
      out += `\\${ENCODE_ESCAPES[byte]}`;
      needsQuote = true;
    } else if (byte < 0x20 || byte >= 0x7f) {
      out += `\\${byte.toString(8).padStart(3, '0')}`;
      needsQuote = true;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return needsQuote ? `"${out}"` : value;
}

/**
 * Split newline-separated git path output (`--name-only`, `ls-files`) into
 * decoded paths.
 * @param {string} stdout - Raw command output
 * @returns {string[]} Decoded, non-empty paths
 */
function splitGitPathLines(stdout) {
  return (stdout || '').trim().split('\n').filter(f => f.length > 0).map(decodeGitPath);
}

/**
 * Decode the path in a `--- ` / `+++ ` file line or a `rename from` /
 * `rename to` extended header. Git terminates a `---`/`+++` path that contains
 * a space with a tab; a tab inside a real name is always C-quoted, so one
 * trailing raw tab is never part of the path.
 * @param {string} value - Text after `--- `, `+++ `, `rename from ` or `rename to `
 * @param {string} [prefix] - Prefix to strip from the decoded path (`a/` or `b/`)
 * @returns {string|null} Decoded path, or null for `/dev/null`
 */
function decodeDiffLinePath(value, prefix = '') {
  const raw = value.endsWith('\t') ? value.slice(0, -1) : value;
  if (raw === '/dev/null') return null;
  const decoded = decodeGitPath(raw);
  return prefix && decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
}

/**
 * Parse the path field of a `git diff --numstat` line (as simple-git's
 * diffSummary reports it in `file.file`). Git prints three shapes:
 *   - a single path, C-quoted when needed:      `"caf\303\251.js"`
 *   - a brace-compacted rename (neither side needed quoting):
 *                                               `src/{old.js => new.js}`
 *   - a full rename, each side quoted independently when it needs it, used
 *     when either side needs quoting or the paths share no prefix/suffix:
 *                                               `lib/x.js => "l\303\257b/x.js"`
 * @param {string} raw - numstat path field
 * @returns {{ file: string, renamedFrom: string|null }} Decoded new path and,
 *   for a rename, the decoded old path
 */
function parseNumstatPath(raw) {
  if (!raw) return { file: raw, renamedFrom: null };
  if (QUOTED_ONLY_RE.test(raw)) {
    return { file: decodeGitPath(raw), renamedFrom: null };
  }
  const braceResolved = resolveRenamedFile(raw);
  if (braceResolved !== raw) {
    return { file: braceResolved, renamedFrom: resolveRenamedFileOld(raw) };
  }
  const arrow = raw.match(ARROW_RENAME_RE);
  if (arrow) {
    return { file: decodeGitPath(arrow[2]), renamedFrom: decodeGitPath(arrow[1]) };
  }
  return { file: raw, renamedFrom: null };
}

module.exports = {
  decodeGitPath,
  quoteGitPath,
  splitGitPathLines,
  decodeDiffLinePath,
  parseNumstatPath
};
