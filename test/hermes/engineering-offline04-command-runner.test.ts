import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitFixtureCommand, startOwnedFixtureCommand } from './fixtures/offline04-command-runner.ts';

test('offline04 command admission accepts exact reviewed bytes and rejects source/network/stdin/phase expansion', () => {
  const base='a'.repeat(40), install='bun install --frozen-lockfile --offline --ignore-scripts';
  expect(()=>admitFixtureCommand('author',install,undefined,base)).not.toThrow();
  for(const command of [install+'; cat /etc/passwd','curl https://example.invalid','bash -c "true"',install.replace('--offline','')]) {
    expect(()=>admitFixtureCommand('author',command,undefined,base)).toThrow('unreviewed');
  }
  expect(()=>admitFixtureCommand('author',install,'unreviewed input',base)).toThrow('unreviewed');
  expect(()=>admitFixtureCommand('verifier','exec bash -c "printf fixture"',undefined,base)).toThrow('unreviewed');
});
test('offline04 command custody observes process-group absence after normal completion and owned timeout', async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'offline04-group-test-'))),env={PATH:'/usr/bin:/bin',HOME:root};
  try {
    const good=startOwnedFixtureCommand('printf bounded-custody',{cwd:root,env,timeoutMs:1000});
    expect(await good.completion).toEqual({output:'bounded-custody',exitCode:0,groupAbsent:true,timedOut:false});await good.stop();
    const timeout=startOwnedFixtureCommand('exec /bin/sleep 5',{cwd:root,env,timeoutMs:30});
    expect(await timeout.completion).toMatchObject({groupAbsent:true,timedOut:true});await timeout.assertAbsent();
  }finally{rmSync(root,{recursive:true,force:true});}
});
