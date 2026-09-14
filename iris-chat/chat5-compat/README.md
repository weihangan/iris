# chat5-compat — conversation service

This directory is the conversation backend of iris-chat. It runs as a local
Express server (`node chat5-compat/server.js`, started automatically by the
Electron main process) on **127.0.0.1:3003**, and is the only component that
talks to both the LLM provider and the local TTS engine.

> Historical note: this code was originally an allow-listed copy of the Chat5.2
> application (137 files audited clean — no user images, settings, history,
> memory, API keys, or absolute paths). In iris-chat it is a first-class,
> runnable part of the framework; its dependencies (`express`, `axios`,
> `multer`, `dotenv`, `form-data`) are declared in the root `package.json`.

## Layout

| Path | Role |
|---|---|
| `server.js` | Express app: chat, voice, runtime and settings APIs; spawns/watches the TTS engine. |
| `services/` | Feature modules: LLM client, prompt builder, history/memory, distill, TTS preflight, ASR, stickers, archive, runtime flavor (CPU/GPU detection). |
| `prompts/` | System prompt, memory and compression templates. |
| `character/1/` | Default character pack: profile, SKILL, lore, knowledge URLs, sticker pack. |
| `public/` | Web chat UI (index.html, app.js, style.css, gapless player, voice segment queue). |
| `tts_engine/` | Python side of voice: `selina_tts_api.py` (HTTP wrapper around GPT-SoVITS, port 9882), `selina_tts_engine.py`, `run_patched.py`. |
| `voice_engine/` | Voice-clone tooling: training pipeline, ASR worker, voice manager, deploy scripts. |
| `data/`, `cache/`, `voice_cache/` | Created at runtime; never commit their contents. |

## Key endpoints

- `POST /api/chat` — main conversation entry (returns text plus emotion/motion tags).
- `GET /api/runtime` — which TTS device (cpu/gpu) is active.
- `GET /api/voice/status`, `POST /api/voice/speak`, `POST /api/voice/speak/stream` — speech synthesis and playback queue.
- `GET /api/voices` — available voice weights.
- ASR (voice input) endpoints for the microphone page.

The TTS chain is: `server.js` → `POST http://127.0.0.1:9882/tts/json` →
`tts_engine/selina_tts_api.py` → GPT-SoVITS (`GPT_SOVITS_ROOT`) → WAV back to
the renderer for lip-sync, expressions and voice motions. Start the TTS engine
with `npm run tts:cpu` / `npm run tts:gpu` before `npm run start` (see the
deployment guide).

## Data boundaries

Never commit: `settings.json`/`.env` (API keys), `*_history.json`,
`*_memory.json`, `voice_tuning.json`, `user.png`, voice weights
(`pth`/`ckpt`/`safetensors`), or anything under `data/`, `cache/`, `logs/`.
