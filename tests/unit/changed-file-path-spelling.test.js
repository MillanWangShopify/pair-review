// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Every producer of changed-file paths must spell a path the way
 * parseUnifiedDiffPatches decodes it from the `diff --git` header. These tests
 * run real git with core.quotePath=true (git's default) so non-ASCII names are
 * C-quoted in every git output format.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { GitWorktreeManager } = require('../../src/git/worktree');
const { mergeChangedFilesWithDiff, parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list');
const { getChangedFiles: getExecutableChangedFiles } = require('../../src/routes/executable-analysis');
const { generateScopedDiff, computeScopedDigest } = require('../../src/local-review');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Pin the formats under test regardless of the developer's global config.
  git(dir, 'config', 'core.quotePath', 'true');
  git(dir, 'config', 'diff.renames', 'true');
  return dir;
}

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

describe('PR mode: numstat paths match decoded diff headers', () => {
  let repo;
  let prData;
  let changedFiles;
  let diff;

  beforeAll(async () => {
    repo = initRepo('changed-file-spelling-pr-');
    write(repo, 'café.js', 'a\nb\n');
    write(repo, 'dir/moved.js', 'm\nn\no\np\n');
    write(repo, 'dïr3/sub.js', '5\n6\n7\n8\n');
    write(repo, 'src/plain.js', 'x\ny\nz\nw\n');
    write(repo, 'src/old.js', 'k\nl\nm\nn\n');
    write(repo, 'ascii.js', 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');

    write(repo, 'café.js', 'a\nb\nc\n');
    git(repo, 'mv', 'dir/moved.js', 'dir/mövéd.js'); // arrow form, destination quoted
    git(repo, 'mv', 'dïr3/sub.js', 'dïr3/süb.js'); // arrow form, both sides quoted
    git(repo, 'mv', 'src/plain.js', 'top.js'); // arrow form, no common prefix/suffix
    git(repo, 'mv', 'src/old.js', 'src/new.js'); // brace form
    write(repo, 'ascii.js', 'one\ntwo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    const headSha = git(repo, 'rev-parse', 'HEAD');

    prData = { base_sha: baseSha, head_sha: headSha };
    const manager = new GitWorktreeManager(null, { worktreeBaseDir: repo });
    changedFiles = await manager.getChangedFiles(repo, prData);
    diff = await manager.generateUnifiedDiff(repo, prData);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reports git-quoted numstat paths in their decoded spelling', () => {
    // Sanity: git really quoted these names in numstat output.
    expect(git(repo, 'diff', '--numstat', `${prData.base_sha}...${prData.head_sha}`))
      .toContain(String.raw`"caf\303\251.js"`);

    const byFile = Object.fromEntries(changedFiles.map(entry => [entry.file, entry]));
    expect(Object.keys(byFile).sort()).toEqual(
      ['ascii.js', 'café.js', 'dir/mövéd.js', 'dïr3/süb.js', 'src/new.js', 'top.js']
    );
    expect(byFile['café.js']).toMatchObject({ insertions: 1, deletions: 0 });
    expect(byFile['café.js'].renamed).toBeUndefined();
    expect(byFile['dir/mövéd.js']).toMatchObject({ renamed: true, renamedFrom: 'dir/moved.js' });
    expect(byFile['dïr3/süb.js']).toMatchObject({ renamed: true, renamedFrom: 'dïr3/sub.js' });
    expect(byFile['top.js']).toMatchObject({ renamed: true, renamedFrom: 'src/plain.js' });
    expect(byFile['src/new.js']).toMatchObject({ renamed: true, renamedFrom: 'src/old.js' });
  });

  it('merges with the unified diff without adding phantom entries', () => {
    expect([...parseUnifiedDiffPatches(diff).keys()].sort())
      .toEqual(changedFiles.map(entry => entry.file).sort());

    const merged = mergeChangedFilesWithDiff(changedFiles, diff);

    expect(merged).toHaveLength(changedFiles.length);
    expect(merged).toEqual(changedFiles);
  });

  it('executable-analysis getChangedFiles lists the same decoded paths', async () => {
    const files = await getExecutableChangedFiles(repo, { baseSha: prData.base_sha, headSha: prData.head_sha });

    expect(files.sort()).toEqual(changedFiles.map(entry => entry.file).sort());
  });
});

describe('PR mode: files literally named like a rename', () => {
  let repo;
  let changedFiles;
  let diff;

  beforeAll(async () => {
    repo = initRepo('changed-file-spelling-arrow-');
    write(repo, 'a => b.md', '1\n');
    write(repo, 'src/{a => b}.md', '1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'a => b.md', '1\n2\n');
    write(repo, 'src/{a => b}.md', '1\n2\n');
    git(repo, 'commit', '-qam', 'head');
    const prData = { base_sha: baseSha, head_sha: git(repo, 'rev-parse', 'HEAD') };
    const manager = new GitWorktreeManager(null, { worktreeBaseDir: repo });
    changedFiles = await manager.getChangedFiles(repo, prData);
    diff = await manager.generateUnifiedDiff(repo, prData);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('merges to the literal names without phantom rename destinations', () => {
    // Sanity: numstat really prints these unquoted, indistinguishable from renames.
    const numstat = git(repo, 'diff', '--numstat', 'HEAD~1', 'HEAD');
    expect(numstat).toContain('\ta => b.md');
    expect(numstat).toContain('\tsrc/{a => b}.md');

    const merged = mergeChangedFilesWithDiff(changedFiles, diff);

    expect(merged.map(entry => entry.file).sort()).toEqual(['a => b.md', 'src/{a => b}.md']);
    expect(merged.every(entry => entry.renamed === undefined && entry.renamedFrom === undefined)).toBe(true);
    expect(merged.find(entry => entry.file === 'a => b.md')).toMatchObject({ insertions: 1, deletions: 0 });
  });
});

describe('Local mode: git-quoted untracked names', () => {
  let repo;

  beforeAll(() => {
    repo = initRepo('changed-file-spelling-local-');
    write(repo, 'tracked.js', 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('includes non-ASCII and $-named untracked files under repo-relative headers', async () => {
    write(repo, 'ünt.js', 'new\n');
    write(repo, '$&odd.js', 'odd\n');
    write(repo, 'café.js', 'tracked soon\n');
    git(repo, 'add', 'café.js');
    write(repo, 'café.js', 'tracked soon\nedited\n');

    const { diff } = await generateScopedDiff(repo, 'staged', 'untracked');
    const patchPaths = [...parseUnifiedDiffPatches(diff).keys()].sort();

    expect(patchPaths).toEqual(['$&odd.js', 'café.js', 'ünt.js']);
    // Synthesized untracked headers are spelled exactly like git's own.
    expect(diff).toContain(String.raw`diff --git "a/\303\274nt.js" "b/\303\274nt.js"`);
    expect(diff).toContain(String.raw`+++ "b/\303\274nt.js"`);
    expect(diff).toContain('diff --git a/$&odd.js b/$&odd.js');
    expect(diff).not.toContain(fs.realpathSync(repo).replace(/^\//, ''));

    const files = await getExecutableChangedFiles(repo, { scopeStart: 'staged', scopeEnd: 'untracked' });
    expect(files.sort()).toEqual(patchPaths);
  });

  it('tracks untracked non-ASCII file changes in the scoped digest', async () => {
    write(repo, 'ünt.js', 'new\n');
    const before = await computeScopedDigest(repo, 'unstaged', 'untracked');
    write(repo, 'ünt.js', 'new\nand longer\n');
    const after = await computeScopedDigest(repo, 'unstaged', 'untracked');

    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });
});
