# iris-chat Full Deployment Guide (AI-executable)

This file is written for both human and AI operators: from zero, download
dependencies, prepare the voice runtime, and start iris-chat with full speech.
Every step includes a verification command; if all pass, deployment succeeded.

## 0. Prerequisites

| Dependency | Version | Purpose | Check |
|---|---|---|---|
| Windows 10/11 x64 | — | Host OS | — |
| Node.js | 18+ | App itself | `node -v` |
| npm | 9+ | Package install | `npm -v` |
| Python | 3.11 (with py launcher) | Creates CPU/GPU virtual envs | `py -3.11 -V` |
| git | any recent | Clones GPT-SoVITS | `git -v` |
| NVIDIA driver | recent | GPU voice only; CPU fallback otherwise | `nvidia-smi` |

When installing Python from https://www.python.org/downloads/ , keep the
"py launcher" option checked. GPT-SoVITS inference source is ~2.21 GB, CPU
Python/Torch ~1.21 GB, GPU Python/Torch ~4.57 GB, plus pretrained base models
and voice weights — none of these are in the repo; they are prepared
automatically or manually by the steps below.

## 1. Install project dependencies

```powershell
npm install
npm run check
```

`npm run check` is a TypeScript type check and must exit without errors.

## 2. One-command voice runtime install

```powershell
npm run runtime:install
```

The script (`scripts/install-runtime.ps1`) will:

1. Create the `runtime/` directory at the repo root;
2. Create the `runtime/python_cpu/` and `runtime/python_gpu/` venvs via the py
   launcher, installing the CPU build and the CUDA 12.6 build of PyTorch plus
   common dependencies respectively;
3. Clone the GPT-SoVITS source into `runtime/gpt-sovits/`;
4. Write `runtime/runtime-config.json`.

CPU-only machines: `powershell -File scripts/install-runtime.ps1 -Device cpu`.
Without git: add `-SkipGptClone`, then manually place the GPT-SoVITS source at
`runtime/gpt-sovits/`.

Verify:

```powershell
Test-Path .\runtime\python_cpu\python.exe     # True
Test-Path .\runtime\python_gpu\python.exe     # True (GPU install only)
Test-Path .\runtime\gpt-sovits\api.py         # True
npm run tts:check:cpu    # CPU runtime self-check passes
npm run tts:check:gpu    # only needed with a GPU install
```

## 3. GPU/CUDA verification (GPU mode only)

```powershell
npm run gpu:check
runtime\python_gpu\python.exe -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.version.cuda)"
```

`cuda_available` must be True and `nvidia-smi` must work. The GPU Torch wheel
ships its own CUDA runtime; regular inference does not need the CUDA Toolkit
(only compiling extensions does: https://developer.nvidia.com/cuda-downloads ).
Drivers: https://www.nvidia.com/Download/index.aspx .
**Without an NVIDIA card or if verification fails, just use CPU mode (step 5
with `tts:cpu`) — fully functional, only slower synthesis.**

## 4. Place GPT-SoVITS base models and voice weights (manual, required)

The cloned GPT-SoVITS contains source only — **no base models, no weights; it
cannot synthesize anything until they are placed**. For licensing reasons this
repo does not distribute them.

1. **Pretrained base models**: follow the official GPT-SoVITS docs
   (https://github.com/RVC-Boss/GPT-SoVITS ) to download the pretrained model
   package for your version (HuggingFace `lj1995/GPT-SoVITS` or the official
   integrated package) and extract it to
   `runtime/gpt-sovits/GPT_SoVITS/pretrained_models/` — HuBERT, BERT, GPT (s1)
   and SoVITS (s2) base models.
2. **Voice weights**: train your own `.ckpt` (GPT) and `.pth` (SoVITS) in the
   app's voice training page, or import existing weights; training outputs and
   reference audio live in userData and never enter Git.
3. Select the voice and configure reference audio in the app's **voice
   settings page**; `chat5-compat/voice_engine/deploy_voice.py` deploys trained
   weights as selectable voices.

Verify: the in-app voice status shows the base models and at least one usable
voice. Never commit any `pth`/`ckpt`/`safetensors`.

## 5. Start

Two windows, in order:

```powershell
# Window A: start TTS first (keep it running)
npm run tts:cpu      # or npm run tts:gpu

# Window B: start the app
npm run start
```

TTS health check (the script uses port 9882 and starts
`runtime/gpt-sovits/api.py`):

```powershell
Invoke-RestMethod http://127.0.0.1:9882/status
Invoke-RestMethod http://127.0.0.1:9882/device
```

`npm run start` builds the renderer and launches Electron, which also brings up
`chat5-compat/server.js` (127.0.0.1:3003).

## 6. Call chain (use while debugging)

```
user input → /api/chat → LLM provider → emotion/lip-sync/motion matching
       → POST http://127.0.0.1:9882/tts/json (chat5-compat/server.js)
       → tts_engine/selina_tts_api.py → GPT-SoVITS → WAV
       → renderer plays audio with lip sync, expressions, voice motions
```

Short sentences synthesize directly; long sentences are split by punctuation
and readable-character count so the first segment can play immediately.
Common endpoints: `/api/runtime`, `/api/voice/status`, `/api/voice/speak`,
`/api/voice/speak/stream`, `/api/voices`, `/api/chat`.

## 7. Model packs (PMX)

Model packs live in `models/<pack>/` — one `manifest.json` plus PMX/textures.
The format and every manifest field are documented in
[models/README.md](models/README.md). The repo ships a minimal example at
`models/赛琳娜Q`. Note: **the example model is for local framework development
only; its license forbids redistribution** — replace it with a model you are
allowed to share before distributing anything.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `install-runtime.ps1` can't find py | Install Python 3.11 with the py launcher, or pass `-PythonLauncher <path>` |
| Missing git | Install git, or rerun with `-SkipGptClone` and place GPT-SoVITS manually |
| Python/runtime not found, TTS won't start | Re-run the three `Test-Path` checks in step 2 |
| CUDA unavailable | Check driver, `nvidia-smi`, step 3 verification; fall back to CPU mode |
| Port 9882 occupied | Kill the stale TTS/python process in Task Manager and restart |
| Text replies but no speech | Check `/api/voice/status` first, then confirm step 4 base models, weights, and reference audio |
| Model motions missing | Compare the manifest bone/morph mappings against [models/README.md](models/README.md) |

## 9. AI acceptance checklist

- [ ] `npm run check` passes
- [ ] `runtime/python_cpu/python.exe` imports torch; with GPU, `torch.cuda.is_available()` is True
- [ ] `runtime/gpt-sovits/api.py` exists and `http://127.0.0.1:9882/status` succeeds
- [ ] `/api/runtime` reports the correct device (cpu/gpu)
- [ ] Short-sentence `POST /api/voice/speak` returns a WAV
- [ ] `npm run start` opens the UI; typed input gets a reply and speech
- [ ] Repo contains no secrets, userData, chat logs, or model weights (`npm run audit:iris` assists)
