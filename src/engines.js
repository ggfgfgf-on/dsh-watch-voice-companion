/**
 * engines.js — 探测本机可用的声音引擎，并把"念一句"实现成可注入的 Promise。
 * 核心不认识这里的任何东西；没有引擎时 companion 不订阅，核心就回到叫醒模型那条路。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgeRate } from './config.js';

const WINDOWS = 'win32';

/** 默认探测：不经过 shell；绝对路径存在即算可用。 */
export async function commandExists(cmd, { platform = process.platform, env = process.env } = {}) {
  const bin = String(cmd ?? '').trim();
  if (!bin) return false;
  if (/[\\/]/.test(bin)) {
    try { await stat(bin); return true; } catch { return false; }
  }
  const probe = platform === WINDOWS ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(probe, [bin], { stdio: 'ignore', windowsHide: true, env });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

/**
 * 返回候选引擎数组。顺序就是降级顺序：
 *   edge-tts + ffplay  >  Windows SAPI  >  macOS say  >  Linux espeak-ng
 * 强制 engine 时只保留匹配项；找不到就返回空数组，绝不抛。
 */
export async function resolveEngines(config, {
  platform = process.platform,
  hasCommand = (cmd) => commandExists(cmd, { platform }),
} = {}) {
  const specs = [];
  const check = async (cmd) => {
    try { return Boolean(await hasCommand(cmd)); } catch { return false; }
  };

  if (await check(config.edgeTts) && await check(config.ffplay)) {
    specs.push({ name: 'edge', edgeBin: config.edgeTts, ffplayBin: config.ffplay });
  }
  if (platform === WINDOWS && await check(config.powershell)) {
    specs.push({ name: 'sapi', powershell: config.powershell });
  }
  if (platform === 'darwin' && await check('say')) {
    specs.push({ name: 'say' });
  }
  if (platform !== WINDOWS && platform !== 'darwin') {
    for (const bin of ['espeak-ng', 'espeak']) {
      if (await check(bin)) { specs.push({ name: 'espeak', bin }); break; }
    }
  }

  const forced = String(config.engine ?? 'auto').toLowerCase();
  if (forced && forced !== 'auto') return specs.filter((e) => e.name === forced);
  return specs;
}

/** 把 child 交给队列，detach 时才有东西可杀。 */
export function runProcess(bin, args, {
  timeoutMs = 60_000, env = process.env, register = () => {}, onChild = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let timer = null;
    try {
      child = spawn(bin, args, { stdio: 'ignore', windowsHide: true, env });
    } catch (e) {
      reject(e);
      return;
    }
    const done = (fn, value) => {
      if (timer) clearTimeout(timer);
      timer = null;
      try { onChild?.(null); } catch { /* 不影响结果 */ }
      fn(value);
    };
    try { onChild?.(child); } catch { /* 不影响结果 */ }
    try { register(child); } catch { /* 不影响结果 */ }
    child.once('error', (e) => done(reject, e));
    child.once('close', (code, signal) => {
      if (code === 0) done(resolve, { ok: true, code });
      else done(reject, new Error(signal ? `killed (${signal})` : `exit ${code}`));
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
        done(reject, new Error('timeout'));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/** edge-tts 合成 + ffplay 播放。onStart 只由尚未上报的调用方传入。 */
async function speakEdge(e, { config, run, onStart, register }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-voice-'));
  const out = join(dir, 'line.mp3');
  try {
    const args = ['--voice', config.voice, '--text', String(e.text), '--write-media', out];
    const rate = edgeRate(config.rate);
    if (rate) args.push(`--rate=${rate}`);
    await run(e.edgeBin, args, { timeoutMs: config.synthTimeoutMs, register });
    const st = await stat(out);
    if (!st.size || st.size < 800) throw new Error('empty audio');
    onStart?.();
    await run(e.ffplayBin, ['-nodisp', '-autoexit', '-loglevel', 'quiet', out], {
      timeoutMs: config.playTimeoutMs,
      register,
    });
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function speakSapi(e, { config, run, onStart, register }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-watch-voice-'));
  const textFile = join(dir, 'line.txt');
  try {
    await writeFile(textFile, String(e.text), 'utf8');
    const rate = Math.round(Math.max(-10, Math.min(10, Number(config.rate) || 0)));
    // 文本从临时文件读，不拼进 PowerShell 脚本：模型写的引号/分号不会变成命令。
    const script = `$v = New-Object -ComObject SAPI.SpVoice; $v.Rate = ${rate}; $null = $v.Speak([IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}'))`;
    onStart?.();
    await run(e.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: config.playTimeoutMs,
      register,
    });
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function speakSay(e, { config, run, onStart, register }) {
  const rate = Math.round(180 + (Number(config.rate) || 0) * 12);
  onStart?.();
  await run('say', ['-r', String(rate), String(e.text)], {
    timeoutMs: config.playTimeoutMs,
    register,
  });
  return true;
}

async function speakEspeak(e, { config, run, onStart, register }) {
  const wpm = Math.round(165 + (Number(config.rate) || 0) * 10);
  onStart?.();
  await run(e.bin, ['-s', String(wpm), String(e.text)], {
    timeoutMs: config.playTimeoutMs,
    register,
  });
  return true;
}

/**
 * 按顺序尝试引擎。只有真正开始播放时才调用 onStart（调用方负责去重）。
 * @returns {Promise<{ok:boolean, engine?:string, reason?:string}>}
 */
export async function speakWithEngines(event, {
  engines, config, run = runProcess, onStart = null, register = () => {},
}) {
  let lastReason = 'no-engine';
  for (const engine of engines) {
    try {
      if (engine.name === 'edge') {
        await speakEdge({ ...event, ...engine }, { config, run, onStart, register });
      } else if (engine.name === 'sapi') {
        await speakSapi({ ...event, ...engine }, { config, run, onStart, register });
      } else if (engine.name === 'say') {
        await speakSay({ ...event, ...engine }, { config, run, onStart, register });
      } else if (engine.name === 'espeak') {
        await speakEspeak({ ...event, ...engine }, { config, run, onStart, register });
      } else {
        continue;
      }
      return { ok: true, engine: engine.name };
    } catch (e) {
      lastReason = String(e?.message ?? e);
    }
  }
  return { ok: false, reason: lastReason };
}
