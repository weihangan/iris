# iris-chat Project Introduction

iris-chat is a replicable Electron + TypeScript 3D character-chat development
framework: PMX desktop-pet rendering + a full conversation service (LLM,
memory, speech recognition, speech synthesis) + voice-clone training, all
running locally. The GitHub repository contains source code and small example
assets only — no GPT-SoVITS, Python/Torch, CUDA, voice weights, or API keys.
Those heavy pieces are prepared via
[README-Deployment-Guide.en.md](README-Deployment-Guide.en.md).

## Feature overview

- **3D desktop pet**: PMX rendering (three-mmd-loader), lip sync, expressions,
  VMD motions, physics, dragging, zoom, turning, idle pools.
- **Conversation**: LLM chat (emotion/lip-sync/motion tags drive performance),
  chat history, long-term memory, search distillation, character Skills and
  sticker packs.
- **Voice**: local GPT-SoVITS synthesis (CPU/GPU auto-selection), segmented
  streaming playback for long sentences, microphone voice input (ASR).
- **Voice cloning**: built-in training page — audio collection, slicing,
  labeling, training, deployment as selectable voices.
- **Multi-window**: chat window, desktop-pet window, composer bar; background,
  lighting, transparency, click-through, tray recovery.

## Architecture and call flow

```
Electron main process (electron/)
  ├─ chat window / desktop-pet window / composer bar (src/ renderer, three.js PMX)
  └─ starts and watches chat5-compat/server.js
        ├─ /api/chat → LLM provider (OpenAI / Anthropic / custom compatible)
        │     → emotion, lip-sync, motion matching → pet performance
        └─ POST 127.0.0.1:9882/tts/json → tts_engine/selina_tts_api.py
              → GPT-SoVITS (runtime/gpt-sovits, CPU or GPU) → WAV → playback + lip sync + voice motions
```

Short sentences synthesize directly; long sentences are split by punctuation
and readable-character count so the first segment plays immediately while the
rest queue seamlessly. In mute or text-only mode only text is shown — no fake
lip sync is ever generated.

## Repository map

| Path | Contents |
|---|---|
| `src/` | Renderer: model loading, motion/physics, lighting, desktop-avatar renderer, conversation controller, model-pack types |
| `electron/` | Main process: window lifecycle, mode control, tray, IPC policies |
| `chat5-compat/` | Conversation service (Express, 127.0.0.1:3003): `server.js` + `services/` (LLM client, memory, distillation, TTS preflight, ASR) + `prompts/` + `public/` (web chat UI) + `character/1/` (default character pack) + `tts_engine/` (GPT-SoVITS Python wrapper) + `voice_engine/` (clone training pipeline) — see [chat5-compat/README.md](chat5-compat/README.md) |
| `models/` | Model packs + shared VMD / voice-action pools; pack format in [models/README.md](models/README.md) |
| `scripts/` | Runtime install/check/start/switch, GPU driver check, voice-clone install, release preparation |
| `tests/` | Vitest unit tests + Playwright e2e |
| `docs/superpowers/` | Internal workflow docs |

## Shared performance pools and model adaptation

Emotion recipes, gesture pools, and voice-action pools are shared globally;
each model describes its own morphs, bones, lip sync, gaze, and physics
mapping in its `manifest.json`. The framework only executes what a manifest
maps — Selena-specific morphs are never forced onto other models. After an
action finishes, the character returns to its default idle; head voice motions
never replace the body idle.

## Characters and settings pages

- Create multiple characters; search-distill to generate Skills; user nickname
  and extra settings take priority over style constraints and are editable.
- Voice settings page: select voice, reference audio, and CPU/GPU device.
- Model page: model, avatar, background, lighting, zoom, transparency,
  click-through, turning, idle configuration.

## LLM provider

The default provider is an empty custom configuration. OpenAI-compatible
`chat/completions`, Anthropic-compatible `messages`, and dynamic `models`
listing are supported. The bundled examples show the format only — fill in
your own endpoint and key (stored in userData, never committed).

## Build and release boundaries

- `npm run start`: build + run; `npm run build`: renderer only; `npm run test`
  / `npm run test:e2e`.
- Packaging lives in the `build` field of `package.json` (electron-builder,
  output `release-dist/`, no asar).
- Never commit: `runtime/`, `node_modules/`, `dist/`, userData, API keys,
  `pth`/`ckpt`/`safetensors` weights, chat history or memory files.
- The example model in `models/` is for local development only; its license
  forbids redistribution (see models/README.md).

## Next steps

Follow [README-Deployment-Guide.en.md](README-Deployment-Guide.en.md) for the
full voice deployment; Chinese version:
[README-部署指南.md](README-部署指南.md).
