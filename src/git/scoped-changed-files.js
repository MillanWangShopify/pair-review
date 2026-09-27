// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Scope-aware changed-file listing for Local mode.
 *
 * A leaf module (no database, route or local-review imports) so utilities that
 * sit below the routes — e.g. `getDiffFileList` — can list a review's scoped
 * files without a require cycle through local-review -> server -> routes.
 */
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const { GIT_DIFF_FLAGS } = require('./diff-flags');
const { splitGitPathLines } = require('../utils/git-paths');
const { scopeIncludes } = require('../local-scope');

const execPromise = promisify(exec);

/**
 * Find merge-base between baseBranch and HEAD using local refs.
 * This is only used in local review mode where the local ref is authoritative.
 * @param {string} repoPath - Path to the git repository
 * @param {string} baseBranch - Base branch name
 * @returns {Promise<string>} Merge-base SHA
 */
async function findMergeBase(repoPath, baseBranch) {
  if (!baseBranch || !/^[\w.\-\/]+$/.test(baseBranch)) {
    throw new Error(`Invalid branch name: ${baseBranch}`);
  }

  try {
    return execSync(`git merge-base ${baseBranch} HEAD`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw new Error(`Could not find merge-base between ${baseBranch} and HEAD: ${error.message}`);
  }
}

const defaults = { findMergeBase };

/**
 * List the decoded paths changed within a Local review's scope stops
 * (branch, staged, unstaged, untracked). Without scope fields, lists
 * unstaged + untracked + staged. Throws on git failure; callers decide
 * whether an unreadable repository means "no files" or an error.
 *
 * @param {string} cwd - Repository root
 * @param {Object} [scope]
 * @param {string} [scope.scopeStart] - First scope stop
 * @param {string} [scope.scopeEnd] - Last scope stop
 * @param {string} [scope.baseBranch] - Base branch; the branch stop is skipped without one
 * @param {Object} [_deps] - Dependency overrides ({ findMergeBase })
 * @returns {Promise<string[]>} Unique changed file paths
 */
async function listScopedChangedFiles(cwd, { scopeStart, scopeEnd, baseBranch } = {}, _deps) {
  const deps = { ...defaults, ..._deps };
  const run = command => execPromise(command, { cwd }).then(result => result.stdout);
  const commands = [];

  if (scopeStart && scopeEnd) {
    if (scopeIncludes(scopeStart, scopeEnd, 'branch') && baseBranch) {
      const mergeBase = await deps.findMergeBase(cwd, baseBranch);
      commands.push(run(`git diff ${GIT_DIFF_FLAGS} ${mergeBase}..HEAD --name-only`));
    }
    if (scopeIncludes(scopeStart, scopeEnd, 'staged')) {
      commands.push(run(`git diff ${GIT_DIFF_FLAGS} --cached --name-only`));
    }
    if (scopeIncludes(scopeStart, scopeEnd, 'unstaged')) {
      commands.push(run(`git diff ${GIT_DIFF_FLAGS} --name-only`));
    }
    if (scopeIncludes(scopeStart, scopeEnd, 'untracked')) {
      commands.push(run('git ls-files --others --exclude-standard'));
    }
  } else {
    // No scope info — include unstaged + untracked + staged
    commands.push(
      run(`git diff ${GIT_DIFF_FLAGS} --name-only`),
      run('git ls-files --others --exclude-standard'),
      run(`git diff ${GIT_DIFF_FLAGS} --cached --name-only`)
    );
  }

  const results = await Promise.all(commands);
  return [...new Set(results.flatMap(splitGitPathLines))];
}

module.exports = { findMergeBase, listScopedChangedFiles };
