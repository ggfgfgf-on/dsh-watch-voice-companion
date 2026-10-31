# dsh-watch-voice-companion

Standalone TTS adapter for [`dsh-watch-together`](https://github.com/SAOS-3624/dsh-watch-together).
The core emits speech events and never imports an engine. This package owns the engine,
synthesis, playback, and the bounded serial queue.

## Install

Not published to npm yet. Install from the repository:

```bash
npm install github:ggfgfgf-on/dsh-watch-voice-companion
# or, from a checkout:
npm install /path/to/dsh-watch-voice-companion
```

Configure the core once:

```json
// ~/.dsh/voice.json
{ "adapter": "dsh-watch-voice-companion" }
```

Or set `DSH_VOICE_ADAPTER=dsh-watch-voice-companion`.

## Engine order

1. `edge-tts` synthesis + `ffplay` playback
2. Windows SAPI (PowerShell)
3. macOS `say`
4. Linux `espeak-ng` / `espeak`

The first available engine wins. If no engine is found, the adapter does not subscribe:
the core keeps waking the model, so watching is never silently muted by a broken engine.

## Config

`~/.dsh/watch-voice.json` (or `DSH_WATCH_VOICE_CONFIG`):

```json
{
  "engine": "auto",
  "voice": "zh-CN-XiaoxiaoNeural",
  "rate": 0,
  "maxQueue": 2,
  "maxLatencyMs": 3500,
  "maxLateSec": 8
}
```

- `engine`: `auto` | `edge` | `sapi` | `say` | `espeak`
- `rate`: edge uses `-10..10` (old semantics, `*3` percent); a string like `"+10%"` is passed through
- `maxQueue`: at most this many due lines waiting; overflow drops the oldest and reports `skipped`
- `maxLatencyMs`: drop a queued line that waited longer than this
- `maxLateSec`: if the core exposes `position()`, drop a line whose playback time is this far behind

See `docs/VOICE.zh.md` in the core package for the event contract. The important part:

- subscribe with `voice: true`;
- call `emitSpoken(event)` immediately before playback starts;
- call `emitSpeech({ ...event, state: "skipped" })` when a line is dropped.

## Development

```bash
npm test
npm run check
```

The adapter is intentionally dependency-free and testable with injected engines/processes.
