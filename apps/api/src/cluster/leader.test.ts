import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaderElector } from './leader.js';

class FakeRedis {
  value: string | undefined;
  async set(_key: string, value: string, options: { NX: true; PX: number }) { if (options.NX && this.value) return null; this.value = value; return 'OK'; }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const token = options.arguments[0]!;
    if (this.value !== token) return 0;
    if (script.includes('DEL')) { this.value = undefined; return 1; }
    return 1;
  }
  async quit() {}
}

test('leader lease starts jobs once, loses leadership and releases only its own lock', async () => {
  const redis = new FakeRedis();
  const transitions: string[] = [];
  const leader = new LeaderElector(redis, 'leader', 3_000, 500, { onLeader: async () => { transitions.push('leader'); }, onFollower: async () => { transitions.push('follower'); } });
  await leader.start();
  assert.equal(leader.isLeader(), true);
  assert.deepEqual(transitions, ['leader']);
  redis.value = 'owned-by-other-instance';
  await (leader as unknown as { reconcile: () => Promise<void> }).reconcile();
  assert.equal(leader.isLeader(), false);
  assert.deepEqual(transitions, ['leader', 'follower']);
  await leader.stop();
  assert.equal(redis.value, 'owned-by-other-instance');
});

test('leader immediately stops work when Redis becomes unavailable and only reacquires after a new lease', async () => {
  const redis = new FakeRedis();
  const transitions: string[] = [];
  let available = true;
  const leader = new LeaderElector(redis, 'leader', 3_000, 500, { onLeader: async () => { transitions.push('leader'); }, onFollower: async () => { transitions.push('follower'); } }, () => available);
  await leader.start();
  assert.equal(leader.isLeader(), true);
  available = false;
  await leader.dependencyUnavailable();
  assert.equal(leader.isLeader(), false);
  assert.deepEqual(transitions, ['leader', 'follower']);
  redis.value = undefined;
  available = true;
  await leader.dependencyAvailable();
  assert.equal(leader.isLeader(), true);
  assert.deepEqual(transitions, ['leader', 'follower', 'leader']);
  await leader.stop();
});
