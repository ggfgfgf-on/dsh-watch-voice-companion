/**
 * dsh-watch-voice-companion — independent TTS adapter for dsh-watch-together.
 *
 * The core bus only emits speech events. This package:
 *   - probes an engine (edge-tts/ffplay, Windows SAPI, macOS say, espeak-ng);
 *   - subscribes with voice: true only when an engine is actually available;
 *   - owns a bounded serial queue, so late lines are skipped instead of played late;
 *   - kills the current process and clears the queue on detach.
 *
 * No engine is imported by the core; if this package is absent or has no engine,
 * core falls back to waking the model exactly as before.
 */
import { loadConfig } from './config.js';
import { resolveEngines, speakWithEngines } from './engines.js';

export const adapterName = 'dsh-watch-voice-companion';

function field(event, key) {
  return event && event[key] !== undefined ? event[key] : undefined;
}

function eventForReport(event, state) {
  return {
    at: field(event, 'at'),
    text: field(event, 'text'),
    state,
    ...(field(event, 'input') !== undefined ? { input: field(event, 'input') } : {}),
    ...(field(event, 'segment') !== undefined ? { segment: field(event, 'segment') } : {}),
    ...(field(event, 'origin') !== undefined ? { origin: field(event, 'origin') } : {}),
  };
}

function fmtAt(at) {
  const s = Math.max(0, Number(at) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * @param {object} api { onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech, position? }
 * @param {object} [options]
 * @param {object} [options.config] 覆盖配置（测试用）
 * @param {Array} [options.engines] 覆盖探测结果（测试用）
 * @param {Function} [options.run] 覆盖进程执行器（测试用）
 * @param {Function} [options.speak] 覆盖整句播放（测试用）
 */
export async function createCompanion(api, options = {}) {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  const log = options.log ?? ((msg) => console.error(`[voice-companion] ${msg}`));
  const engines = options.engines ?? await resolveEngines(config, {
    platform: options.platform,
    hasCommand: options.hasCommand,
  });

  if (!Array.isArray(engines) || engines.length === 0) {
    log('没有可用引擎（edge-tts + ffplay / SAPI / say / espeak-ng 都没探测到）；不订阅');
    return { ok: false, reason: 'no-engine', engine: null, detach: () => {} };
  }
  if (typeof api?.onSpeech !== 'function') {
    return { ok: false, reason: 'bad-api', engine: null, detach: () => {} };
  }

  const queue = [];
  let running = false;
  let stopped = false;
  let detachOff = null;
  let currentChild = null;

  const emitSpoken = typeof api.emitSpoken === 'function' ? api.emitSpoken.bind(api) : null;
  const emitSpeech = typeof api.emitSpeech === 'function' ? api.emitSpeech.bind(api) : null;
  const position = typeof api.position === 'function' ? api.position.bind(api) : null;

  function skip(event, reason) {
    log(`跳过 @${fmtAt(event?.at)}（${reason}）：${String(event?.text ?? '').slice(0, 50)}`);
    try { emitSpeech?.(eventForReport(event, 'skipped')); } catch { /* 上报失败不影响队列 */ }
  }

  function expired(item) {
    if (stopped) return true;
    const now = Date.now();
    if (now - item.receivedAt > config.maxLatencyMs) return true;
    if (position) {
      let pos = NaN;
      try { pos = Number(position()); } catch { /* 位置不可用 */ }
      if (Number.isFinite(pos) && Number.isFinite(item.at) && pos - item.at > config.maxLateSec) return true;
    }
    return false;
  }

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length > 0) {
        const item = queue.shift();
        if (expired(item)) { skip(item, 'too-late'); continue; }

        let started = false;
        const onStart = () => {
          if (started) return;
          started = true;
          try { emitSpoken?.(eventForReport(item, 'spoken')); } catch { /* 不影响播放 */ }
        };

        try {
          if (typeof options.speak === 'function') {
            await options.speak(item, { config, engines, onStart });
          } else {
            const r = await speakWithEngines(item, {
              engines,
              config,
              run: options.run,
              onStart,
              register: (child) => { currentChild = child; },
            });
            if (!r.ok) { skip(item, r.reason ?? 'engine-failed'); continue; }
          }
        } catch (e) {
          skip(item, String(e?.message ?? e));
        } finally {
          currentChild = null;
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(event) {
    if (stopped || event?.state !== 'due') return;
    if (!String(event.text ?? '').trim()) return;
    queue.push({
      at: event.at,
      text: String(event.text),
      input: event.input,
      segment: event.segment,
      origin: event.origin,
      receivedAt: Date.now(),
    });
    // 超过上限时丢最旧的：最新一句通常更贴近当前画面。
    while (queue.length > config.maxQueue) {
      skip(queue.shift(), 'queue-overflow');
    }
    void drain();
  }

  detachOff = api.onSpeech(enqueue, { voice: true });
  log(`已接上 engine=${engines[0].name} queue=${config.maxQueue} voice=${config.voice}`);

  return {
    ok: true,
    engine: engines[0].name,
    engines,
    detach() {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      try { detachOff?.(); } catch { /* 已经退订 */ }
      try { currentChild?.kill('SIGKILL'); } catch { /* 已经退出 */ }
      currentChild = null;
    },
  };
}

/** 核心的 adapter 入口：加载时取 mod.attach，返回 detach。 */
export async function attach(api, options = {}) {
  const companion = await createCompanion(api, options);
  return companion.detach;
}

export default attach;
