import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { RedisConnectionHealth, redisReconnectDelay } from './redis.js';

test('Redis lifecycle handles error events, exposes health and rate-limits repeated logs', () => {
  const client = new EventEmitter();
  const logs: Array<Record<string, unknown>> = [];
  let now = 0;
  const health = new RedisConnectionHealth('test-client', entry => logs.push(entry), () => now).bind(client);
  const states: string[] = [];
  health.subscribe(state => states.push(state));

  client.emit('ready');
  assert.equal(health.isReady(), true);
  client.emit('error', new Error('ECONNRESET'));
  client.emit('error', new Error('ECONNRESET'));
  assert.equal(health.isReady(), false);
  assert.equal(logs.filter(entry => entry.event === 'redis_connection_error').length, 1);
  now = 5_001;
  client.emit('error', new Error('ECONNRESET'));
  assert.equal(logs.filter(entry => entry.event === 'redis_connection_error').length, 2);
  client.emit('reconnecting');
  client.emit('ready');
  assert.deepEqual(states, ['ready', 'unavailable', 'reconnecting', 'ready']);
});

test('Redis reconnect delay has bounded exponential backoff with jitter', () => {
  assert.equal(redisReconnectDelay(0, () => 0), 100);
  assert.ok(redisReconnectDelay(4, () => 0.99) > redisReconnectDelay(3, () => 0));
  assert.ok(redisReconnectDelay(10_000, () => 0.99) <= 5_000);
});
