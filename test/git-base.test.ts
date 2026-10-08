import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRemoteBase, createWorktree, ensureBareClone, getDiff, gitMust, isSafeGitBranch, rebaseOntoFreshBase, type PinnedGitBase } from '../src/git.ts';

describe('pinned remote coding base with real local Git repositories', () => {
  let root: string, origin: string, reposDir: string, worktreePath: string;
  let mainCommit: string, base: PinnedGitBase;
  const branch = 'codex/baseline-test-repairs';
  const command = async (cwd: string, ...args: string[]) => (await gitMust(args, { cwd })).stdout.trim();
  async function commit(cwd: string, file: string, content: string) {
    writeFileSync(join(cwd, file), content);
    await command(cwd, 'add', file); await command(cwd, 'commit', '-qm', file);
    return command(cwd, 'rev-parse', 'HEAD');
  }
  const cloneArgs = () => ({ owner: 'fixture', repo: 'repo', reposDir, freshTokenUrl: origin });
  const worktreeArgs = (bareDir: string) => ({ bareDir, worktreePath, branch: 'ERT-3181-task',
    baseBranch: base.branch, expectedBaseCommit: base.commit, authorName: 'Fixture', authorEmail: 'fixture@example.invalid' });
  const rebaseArgs = (bareDir: string) => ({ bareDir, worktreePath, freshTokenUrl: origin,
    baseBranch: base.branch, expectedBaseCommit: base.commit });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gary-pinned-base-'));
    origin = join(root, 'origin'); reposDir = join(root, 'repos'); worktreePath = join(root, 'worktree');
    await gitMust(['init', '-q', '-b', 'main', origin]);
    await command(origin, 'config', 'user.name', 'Fixture'); await command(origin, 'config', 'user.email', 'fixture@example.invalid');
    await command(origin, 'config', 'commit.gpgsign', 'false'); await command(origin, 'config', 'core.hooksPath', '/dev/null');
    mainCommit = await commit(origin, 'app.ts', 'base app\n');
    await command(origin, 'checkout', '-qb', branch);
    base = { branch, commit: await commit(origin, 'prerequisite.test.ts', 'separate test repair\n') };
    await command(origin, 'checkout', '-q', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('starts from the exact green prerequisite and excludes it from the task diff', async () => {
    const bareDir = await ensureBareClone({ ...cloneArgs(), base });
    await createWorktree(worktreeArgs(bareDir));
    expect(await command(worktreePath, 'rev-parse', 'HEAD')).toBe(base.commit);
    expect(readFileSync(join(worktreePath, 'prerequisite.test.ts'), 'utf8')).toBe('separate test repair\n');
    const head = await commit(worktreePath, 'app.ts', 'task fix\n');
    const diff = await getDiff(worktreePath, base.commit);
    expect(diff).toContain('task fix'); expect(diff).not.toContain('prerequisite.test.ts');
    expect(await rebaseOntoFreshBase(rebaseArgs(bareDir))).toEqual({ kind: 'no_op', sha: head });
    await assertRemoteBase({ base, freshTokenUrl: origin, worktreePath });
    expect(await command(bareDir, 'rev-parse', 'main')).toBe(mainCommit);
  });

  it('refreshes the selected branch in an existing clone while retaining legacy main behavior', async () => {
    const bareDir = await ensureBareClone(cloneArgs());
    await command(origin, 'checkout', '-q', branch);
    const next = await commit(origin, 'prerequisite.test.ts', 'new explicitly admitted repair\n');
    await command(origin, 'checkout', '-q', 'main');
    const latestMain = await commit(origin, 'unrelated.txt', 'new main\n');
    base = { branch, commit: next };
    expect(await ensureBareClone({ ...cloneArgs(), base })).toBe(bareDir);
    expect(await command(bareDir, 'rev-parse', branch)).toBe(next);
    expect(await command(bareDir, 'rev-parse', 'main')).toBe(mainCommit);
    await ensureBareClone(cloneArgs());
    expect(await command(bareDir, 'rev-parse', 'main')).toBe(latestMain);
  });

  for (const existing of [false, true]) it('rejects a wrong commit in a ' + (existing ? 'cached' : 'new') + ' clone', async () => {
    if (existing) await ensureBareClone(cloneArgs());
    await expect(ensureBareClone({ ...cloneArgs(), base: { branch, commit: mainCommit } })).rejects.toThrow('pinned_git_base_changed');
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('does not use a stale local branch when the remote prerequisite is deleted', async () => {
    const bareDir = await ensureBareClone({ ...cloneArgs(), base });
    await command(origin, 'branch', '-D', branch);
    expect(await command(bareDir, 'rev-parse', branch)).toBe(base.commit);
    await expect(ensureBareClone({ ...cloneArgs(), base })).rejects.toThrow();
    await expect(assertRemoteBase({ base, freshTokenUrl: origin, worktreePath: bareDir })).rejects.toThrow();
  });

  it('checks the local base pin before removing an existing workspace', async () => {
    const bareDir = await ensureBareClone({ ...cloneArgs(), base });
    mkdirSync(worktreePath); writeFileSync(join(worktreePath, 'keep.txt'), 'retain existing work');
    await command(bareDir, 'update-ref', 'refs/heads/' + branch, mainCommit);
    await expect(createWorktree(worktreeArgs(bareDir))).rejects.toThrow('pinned_git_base_changed');
    expect(readFileSync(join(worktreePath, 'keep.txt'), 'utf8')).toBe('retain existing work');
  });

  it('rejects using the prerequisite itself as the writable work branch', async () => {
    const bareDir = await ensureBareClone({ ...cloneArgs(), base });
    await expect(createWorktree({ ...worktreeArgs(bareDir), branch })).rejects.toThrow('pinned_git_base_is_work_branch');
    expect(await command(bareDir, 'rev-parse', branch)).toBe(base.commit);
    expect(existsSync(worktreePath)).toBe(false);
  });

  for (const mode of ['advance', 'delete'] as const) it('rejects remote ' + mode + ' without rebasing the reviewed task', async () => {
    const bareDir = await ensureBareClone({ ...cloneArgs(), base }); await createWorktree(worktreeArgs(bareDir));
    const head = await commit(worktreePath, 'app.ts', 'task fix\n');
    if (mode === 'advance') {
      await command(origin, 'checkout', '-q', branch); await commit(origin, 'prerequisite.test.ts', 'moved prerequisite\n');
    } else await command(origin, 'branch', '-D', branch);
    await expect(rebaseOntoFreshBase(rebaseArgs(bareDir))).rejects.toThrow();
    expect(await command(worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await command(worktreePath, 'status', '--porcelain=v1')).toBe('');
    expect(readFileSync(join(worktreePath, 'prerequisite.test.ts'), 'utf8')).toBe('separate test repair\n');
    await expect(assertRemoteBase({ base, freshTokenUrl: origin, worktreePath })).rejects.toThrow();
  });

  it('rejects refspec/revision syntax before creating a repository directory', async () => {
    await expect(ensureBareClone({ ...cloneArgs(), base: { branch: 'main:other', commit: base.commit } })).rejects.toThrow('invalid_pinned_git_base');
    expect(existsSync(reposDir)).toBe(false);
    for (const name of ['main', 'codex/baseline-test-repairs-20261008']) expect(isSafeGitBranch(name)).toBe(true);
    for (const name of ['', 'HEAD', '-option', 'a..b', 'a.lock', 'a/.b', 'a//b', 'a/', 'refs/heads/main', 'main~1', 'a\nb', 'a*b']) {
      expect(isSafeGitBranch(name)).toBe(false);
    }
  });
});
