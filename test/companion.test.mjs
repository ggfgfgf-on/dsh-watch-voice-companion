import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCompanion, attach } from '../src/index.js';
import { edgeRate, expandHome, loadConfig } from '../src/config.js';
import { resolveEngines } from '../src/engines.js';

function fakeApi() {
  const handlers = new Map();
  const spoken = [];
  const skipped = [];
  const subscribers = [];
  return {
    spoken,
    skipped,
    subscribers,
    onSpeech(fn, opts = {}) {
      handlers.set(fn, { voice: opts.voice !== false });
      subscribers.push({ fn, opts });
      return () => handlers.delete(fn);
    },
    speechSubscribers() {
      return [...handlers.values()].filter((s) => s.voice).length;
    },
    emitSpoken(e) { spoken.push(e); },
    emitSpeech(e) { if (e.state === 'skipped') skipped.push(e); },
    lastSpeech() { return null; },
    send(event) {
      for (const fn of [...handlers.keys()]) fn(event);
    },
  };
}

const BASE_CONFIG = {
  engine: 'auto',
  voice: 'test-voice',
  rate: 0,
  edgeTts: 'edge-tts',
  ffplay: 'ffplay',
  powershell: 'powershell',
  maxQueue: 2,
  maxLatencyMs: 5000,
  maxLateSec: 8,
  synthTimeoutMs: 5000,
  playTimeoutMs: 5000,
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('no engine: do not subscribe, so core keeps waking the model', async () => {
  const api = fakeApi();
  const c = await createCompanion(api, { engines: [], config: BASE_CONFIG });
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'no-engine');
  assert.equal(api.speechSubscribers(), 0);
  c.detach();
});

test('due event is enqueued and reported spoken before playback', async () => {
  const api = fakeApi();
  const started = [];
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: { ...BASE_CONFIG, maxQueue: 1 },
    speak: async (e, { onStart }) => {
      started.push(e.text);
      onStart();
    },
  });
  assert.equal(c.ok, true);
  api.send({ state: 'due', at: 12, text: '第一句' });
  await tick();
  assert.deepEqual(started, ['第一句']);
  assert.equal(api.spoken.length, 1);
  assert.equal(api.spoken[0].state, 'spoken');
  assert.equal(api.spoken[0].text, '第一句');
  c.detach();
});

test('scheduled/spoken/skipped are not queued', async () => {
  const api = fakeApi();
  const seen = [];
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: BASE_CONFIG,
    speak: async (e) => { seen.push(e.state ?? 'due'); },
  });
  for (const state of ['scheduled', 'spoken', 'skipped']) api.send({ state, text: 'x' });
  await tick();
  assert.deepEqual(seen, []);
  c.detach();
});

test('queue overflow drops the oldest and reports skipped', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = fakeApi();
  const started = [];
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: { ...BASE_CONFIG, maxQueue: 1 },
    speak: async (e, { onStart }) => {
      started.push(e.text);
      onStart();
      if (e.text === 'one') await gate;
    },
  });
  api.send({ state: 'due', at: 1, text: 'one' });
  api.send({ state: 'due', at: 2, text: 'two' });
  api.send({ state: 'due', at: 3, text: 'three' });
  await tick();
  assert.deepEqual(started, ['one']);
  assert.equal(api.skipped.length, 1);
  assert.equal(api.skipped[0].text, 'two');
  release();
  await tick();
  assert.deepEqual(started, ['one', 'three']);
  c.detach();
});

test('queued line past maxLatency is skipped instead of played late', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = fakeApi();
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: { ...BASE_CONFIG, maxQueue: 2, maxLatencyMs: 5 },
    speak: async (e, { onStart }) => {
      onStart();
      if (e.text === 'hold') await gate;
    },
  });
  api.send({ state: 'due', at: 1, text: 'hold' });
  await tick();
  api.send({ state: 'due', at: 2, text: 'late' });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await tick();
  assert.equal(api.skipped.length, 1);
  assert.equal(api.skipped[0].text, 'late');
  c.detach();
});

test('position() makes an old event stale even before queue age', async () => {
  const api = fakeApi();
  api.position = () => 100;
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: { ...BASE_CONFIG, maxQueue: 1, maxLateSec: 5 },
    speak: async () => {},
  });
  api.send({ state: 'due', at: 20, text: 'stale-by-position' });
  await tick();
  assert.equal(api.spoken.length, 0);
  assert.equal(api.skipped.length, 1);
  c.detach();
});

test('detach unsubscribes, clears queue, and stops scheduling', async () => {
  const api = fakeApi();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const c = await createCompanion(api, {
    engines: [{ name: 'fake' }],
    config: { ...BASE_CONFIG, maxQueue: 3 },
    speak: async () => { await gate; },
  });
  api.send({ state: 'due', at: 1, text: 'one' });
  await tick();
  c.detach();
  release();
  await tick();
  assert.equal(api.speechSubscribers(), 0);
  api.send({ state: 'due', at: 2, text: 'two' });
  await tick();
  assert.equal(api.spoken.length, 0);
});

test('attach returns the core-compatible detach function', async () => {
  const api = fakeApi();
  const detach = await attach(api, {
    engines: [{ name: 'fake' }],
    config: BASE_CONFIG,
    speak: async () => {},
  });
  assert.equal(typeof detach, 'function');
  assert.equal(api.speechSubscribers(), 1);
  detach();
  assert.equal(api.speechSubscribers(), 0);
});

test('resolveEngines falls back in order and respects forced engine', async () => {
  const has = new Set(['edge-tts', 'ffplay', 'powershell']);
  const engines = await resolveEngines({ ...BASE_CONFIG, engine: 'auto' }, {
    platform: 'win32',
    hasCommand: async (cmd) => has.has(cmd),
  });
  assert.deepEqual(engines.map((e) => e.name), ['edge', 'sapi']);

  const forced = await resolveEngines({ ...BASE_CONFIG, engine: 'sapi' }, {
    platform: 'win32',
    hasCommand: async (cmd) => has.has(cmd),
  });
  assert.deepEqual(forced.map((e) => e.name), ['sapi']);
});

test('config expands ~ and accepts edge rate strings', async () => {
  assert.equal(expandHome('~/x', { HOME: 'C:/Users/me' }), join('C:/Users/me', 'x'));
  assert.equal(expandHome('~\\x', { USERPROFILE: 'C:/Users/me' }), join('C:/Users/me', 'x'));
  assert.equal(edgeRate(0), null);
  assert.equal(edgeRate(2), '+6%');
  assert.equal(edgeRate('-2'), '-6%');
  assert.equal(edgeRate('+15%'), '+15%');
});

test('loadConfig reads its own file and clamps values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-config-'));
  const file = join(dir, 'watch-voice.json');
  await writeFile(file, JSON.stringify({
    engine: 'edge', voice: 'v', rate: 1, maxQueue: 99, maxLatencyMs: 1, maxLateSec: 999,
  }), 'utf8');
  try {
    const c = loadConfig({ DSH_WATCH_VOICE_CONFIG: file });
    assert.equal(c.engine, 'edge');
    assert.equal(c.voice, 'v');
    assert.equal(c.maxQueue, 8);
    assert.equal(c.maxLatencyMs, 500);
    assert.equal(c.maxLateSec, 120);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});