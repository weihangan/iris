# iris-chat Reproducible Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `D:\trae\iris-chat` reproducible on Windows 10/11 with explicit CPU/GPU Python runtimes, local TTS, ASR voice input, and voice-clone training setup.

**Architecture:** Keep ChatX2-compatible application code in the repository and resolve all optional heavy dependencies through a relocatable `runtime/` directory. Installation scripts create or validate runtime components without copying user history, credentials, or model weights into Git.

**Tech Stack:** Electron, TypeScript, Node.js, PowerShell, Python, GPT-SoVITS-compatible HTTP TTS.

## Global Constraints

- `D:\trae\chatX2\release-dist-1.0\ChatX2-Selena-v1.0.0` is read-only.
- No API keys, chat history, cloned voice weights, CUDA toolkit, or large model weights are committed.
- Runtime paths must be derived from the current project directory; no developer absolute paths.
- CPU mode must work without NVIDIA/CUDA; GPU mode must require a CUDA-capable Torch build.
- TTS, ASR, and voice-clone checks must fail with actionable messages.

### Task 1: Runtime Contract

**Files:**
- Create: `runtime/runtime-manifest.json`
- Create: `runtime/README.md`
- Modify: `README.md`

- [ ] Define the canonical runtime layout, package markers, version floors, download sources, and device policy.
- [ ] Document that CUDA Toolkit is optional for inference and required only for compiling extensions.

### Task 2: Relocatable Path Adapter

**Files:**
- Create: `chat5-compat/services/irisRuntimePaths.js`
- Modify: `chat5-compat/services/runtimeFlavor.js`
- Modify: `scripts/start-tts-runtime.ps1`
- Modify: `scripts/check-tts-runtime.ps1`

- [ ] Resolve `runtime/python_cpu`, `runtime/python_gpu`, `runtime/gpt-sovits`, `runtime/asr`, and `runtime/ffmpeg` from the repository root.
- [ ] Preserve environment-variable overrides for advanced users.
- [ ] Use the actual ChatX2 TTS entrypoint `chat5-compat/tts_engine/run_patched.py` and `selina_tts_api.py`.

### Task 3: Dependency Install and Health Checks

**Files:**
- Create: `scripts/install-runtime.ps1`
- Create: `scripts/install-voice-input.ps1`
- Create: `scripts/install-voice-clone.ps1`
- Create: `scripts/audit-iris.ps1`
- Modify: `package.json`

- [ ] Support `-Device cpu|gpu|both`, resumable downloads, SHA-256 verification, and dry-run output.
- [ ] Check Python, Torch, `transformers.utils`, `regex`, `filelock`, SciPy, audio libraries, and CUDA availability.
- [ ] Check ASR modules for local voice input and clone pipeline modules plus FFmpeg/UVR assets for training.
- [ ] Never overwrite user data or credentials.

### Task 4: Deployment Documentation

**Files:**
- Modify: `README-部署指南.md`
- Modify: `README-项目介绍.md`
- Modify: `config.example.json`

- [ ] Document clean-machine setup, CPU/GPU choice, voice input, voice cloning, TTS startup, API configuration, relocation, and troubleshooting.
- [ ] Explain which assets are downloaded separately and why they are not in Git.

### Task 5: Verification

**Files:**
- Create: `tests/unit/iris-runtime-paths.test.js`
- Modify: `tests/unit/portable-release-contract.test.ts` only if a shared contract needs coverage.

- [ ] Test path resolution under a moved directory and environment overrides.
- [ ] Run `npm run check`, the focused unit test, and `powershell -File scripts/audit-iris.ps1`.
- [ ] Confirm the read-only release package timestamps/hashes are unchanged.
