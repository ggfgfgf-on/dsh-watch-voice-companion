/**
 * config.js — companion 自己的配置。核心只读 voice.json 的 adapter 字段，
 * 音色、语速、引擎路径、队列上限都在这里，绝不回灌到核心。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function expandHome(p, env = process.env) {
  const s = String(p ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return s;
}

export function configPath(env = process.env) {
  const explicit = String(env.DSH_WATCH_VOICE_CONFIG ?? '').trim();
  return explicit ? resolve(expandHome(explicit, env)) : join(dshHome(env), 'watch-voice.json');
}

function num(value, fallback, min = 0, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function str(value, fallback = '') {
  return String(value ?? fallback).trim();
}

/** @returns {{engine:string,voice:string,rate:string|number,edgeTts:string,ffplay:string,powershell:string,maxQueue:number,maxLatencyMs:number,maxLateSec:number,synthTimeoutMs:number,playTimeoutMs:number}} */
export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath(env), 'utf8')) ?? {};
  } catch { /* 配置是可选能力：没有就用默认值 */ }

  const engine = str(file.engine, str(env.DSH_WATCH_VOICE_ENGINE, 'auto')).toLowerCase();
  return {
    engine: engine || 'auto',
    voice: str(file.voice, str(env.DSH_WATCH_VOICE, 'zh-CN-YunxiNeural')) || 'zh-CN-YunxiNeural',
    rate: file.rate ?? env.DSH_WATCH_VOICE_RATE ?? 0,
    edgeTts: str(file.edgeTts, 'edge-tts') || 'edge-tts',
    ffplay: str(file.ffplay, 'ffplay') || 'ffplay',
    powershell: str(file.powershell, 'powershell') || 'powershell',
    maxQueue: num(file.maxQueue, 2, 1, 8),
    maxLatencyMs: num(file.maxLatencyMs, 3500, 500, 30_000),
    maxLateSec: num(file.maxLateSec, 8, 1, 120),
    synthTimeoutMs: num(file.synthTimeoutMs, 60_000, 5_000, 180_000),
    playTimeoutMs: num(file.playTimeoutMs, 90_000, 5_000, 300_000),
  };
}

/** 把 rate 统一成 edge-tts 的 "+10%"; 数字按旧配置语义 *3 映射到 -30%..+30%。 */
export function edgeRate(rate) {
  const s = String(rate ?? '').trim();
  if (/^[+-]?\d+%$/.test(s)) return s;
  const n = Number(rate);
  if (!Number.isFinite(n) || n === 0) return null;
  const pct = Math.round(Math.max(-10, Math.min(10, n)) * 3);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
