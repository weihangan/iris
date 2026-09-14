// Portable runtime path resolution for iris-chat.
// The service directory is chat5-compat; the project root is its parent.
const fs = require('fs');
const path = require('path');

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];
}

function firstExisting(candidates, predicate = (value) => fs.existsSync(value)) {
  return unique(candidates).find(predicate) || '';
}

function resolveIrisPaths(serviceRoot = __dirname) {
  const compatRoot = path.resolve(serviceRoot, '..');
  const projectRoot = path.resolve(compatRoot, '..');
  const runtimeRoot = path.resolve(
    process.env.IRIS_RUNTIME_ROOT || process.env.CHATX2_RUNTIME_ROOT || path.join(projectRoot, 'runtime')
  );

  const gptCandidates = [
    process.env.GPT_SOVITS_ROOT,
    process.env.CHATX2_GPT_SOVITS_ROOT,
    path.join(runtimeRoot, 'gpt-sovits'),
    path.join(projectRoot, 'GPT-SoVITS-lite'),
    path.join(projectRoot, 'GPT-SoVITS'),
  ];
  const gptSoVitsRoot = firstExisting(gptCandidates, (candidate) =>
    fs.existsSync(path.join(candidate, 'GPT_SoVITS')) || fs.existsSync(path.join(candidate, 'tools'))
  ) || path.resolve(gptCandidates.find(Boolean) || path.join(runtimeRoot, 'gpt-sovits'));

  const pythonCandidates = (device) => {
    const legacy = device === 'gpu' ? 'python_env_gpu' : 'python_env_cpu';
    const names = device === 'gpu' ? ['python_gpu', 'python_env_gpu'] : ['python_cpu', 'python_env_cpu'];
    return names.flatMap((name) => [
      path.join(runtimeRoot, name, 'python.exe'),
      path.join(projectRoot, name, 'python.exe'),
    ]).concat([
      path.join(gptSoVitsRoot, 'runtime', 'python.exe'),
      path.join(projectRoot, legacy, 'python.exe'),
    ]);
  };

  const cpuPythonExe = firstExisting(pythonCandidates('cpu')) || path.join(runtimeRoot, 'python_cpu', 'python.exe');
  const gpuPythonExe = firstExisting(pythonCandidates('gpu')) || path.join(runtimeRoot, 'python_gpu', 'python.exe');
  const voicesDir = firstExisting([
    process.env.BUNDLED_VOICES_DIR,
    path.join(runtimeRoot, 'voices'),
    path.join(gptSoVitsRoot, 'voices'),
    path.join(projectRoot, 'voices'),
    path.join(compatRoot, 'voices'),
  ], (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
    || path.join(runtimeRoot, 'voices');
  const ffmpegPath = firstExisting([
    process.env.FFMPEG_PATH,
    process.env.CHATX2_FFMPEG_PATH,
    path.join(runtimeRoot, 'ffmpeg', 'ffmpeg.exe'),
    path.join(runtimeRoot, 'ffmpeg.exe'),
    path.join(gptSoVitsRoot, 'ffmpeg.exe'),
    path.join(gptSoVitsRoot, 'tools', 'ffmpeg.exe'),
  ]);

  return {
    projectRoot,
    compatRoot,
    runtimeRoot,
    gptSoVitsRoot,
    cpuPythonExe,
    gpuPythonExe,
    ffmpegPath,
    voicesDir,
    ttsEngineDir: path.join(compatRoot, 'tts_engine'),
    ttsScript: path.join(compatRoot, 'tts_engine', 'selina_tts_api.py'),
    runPatchedScript: path.join(compatRoot, 'tts_engine', 'run_patched.py'),
  };
}

module.exports = { resolveIrisPaths };
