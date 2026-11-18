import { expect, test } from 'bun:test';
import { createLoopWake, runLoop, type RunLoopArgs } from '../src/loop.ts';
import { openDb } from '../src/state/db.ts';

test('wake coalesces while active and during interval wait; stops reject all future requests',async()=>{
  const wake=createLoopWake();expect(wake.request()).toBe(false);wake.start();
  expect(()=>wake.start()).toThrow('loop_wake_already_owned');
  expect(wake.request()).toBe(true);expect(wake.request()).toBe(true);
  await wake.wait(10000);
  const wait=wake.wait(10000);expect(wake.request()).toBe(true);await wait;
  const controller=new AbortController(),last=wake.wait(10000,controller.signal);controller.abort();await last;
  wake.stop();expect(wake.request()).toBe(false);
});

test('real runLoop never overlaps ticks when requests arrive during an async controller read',async()=>{
  const db=openDb(':memory:'),wake=createLoopWake(),controller=new AbortController();
  let active=0,maxActive=0,calls=0;
  const states:string[]=[];
  const args={db,wake,signal:controller.signal,intervalMs:10000,
    glm:{chain:{allArmed:()=>false}},linear:{fetchAssignedIssues:async()=>{
      calls++;active++;maxActive=Math.max(active,maxActive);
      wake.request();wake.request();await Promise.resolve();active--;
      return [];
    }},repoMap:new Map(),allowlistedMentionUserIds:[],
    onTickState:(state:string)=>states.push(state),onTickComplete:()=>{if(calls===2)controller.abort();}
  } as unknown as RunLoopArgs;
  try {
    await runLoop(args);expect(calls).toBe(2);expect(maxActive).toBe(1);
    expect(states).toEqual(['polling','idle','polling','idle','stopped']);expect(wake.request()).toBe(false);
  } finally {db.close();}
});

test('post-tick readiness failure stops wake admission and never starts a second tick',async()=>{
  const db=openDb(':memory:'),wake=createLoopWake();let calls=0;
  const args={db,wake,intervalMs:10000,glm:{chain:{allArmed:()=>false}},linear:{fetchAssignedIssues:async()=>{calls++;wake.request();return [];}},
    repoMap:new Map(),allowlistedMentionUserIds:[],onTickComplete:()=>{throw new Error('readiness_failed');}
  } as unknown as RunLoopArgs;
  try {await expect(runLoop(args)).rejects.toThrow('readiness_failed');expect(calls).toBe(1);expect(wake.request()).toBe(false);}
  finally {db.close();}
});
