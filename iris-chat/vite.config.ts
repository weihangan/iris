import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const projectRoot = __dirname;

function sourceTreeDigest(): string {
  const digest = createHash('sha256');
  const inputs = [
    'src', 'electron', 'scripts',
    'package.json', 'package-lock.json', 'vite.config.ts',
    'models/shared/voice-actions.json',
    'models/selena-xisheng/manifest.json',
    'models/yyxuanling/manifest.json'
  ];
  const files: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b))) {
        if (['node_modules', 'dist', 'release-dist', '__pycache__'].includes(name)) continue;
        visit(join(path, name));
      }
      return;
    }
    files.push(path);
  };
  for (const input of inputs) visit(resolve(projectRoot, input));
  files.sort((a, b) => relative(projectRoot, a).localeCompare(relative(projectRoot, b)));
  for (const file of files) {
    digest.update(relative(projectRoot, file).replace(/\\/g, '/'));
    digest.update('\0');
    digest.update(readFileSync(file));
    digest.update('\0');
  }
  return digest.digest('hex').toUpperCase();
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'NO_GIT_COMMIT';
  }
}

function createBuildIdentity() {
  const sequencePath = resolve(projectRoot, '.chatx2-build-sequence');
  const previous = existsSync(sequencePath)
    ? Number.parseInt(readFileSync(sequencePath, 'utf8').trim(), 10)
    : 0;
  const buildSequence = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  writeFileSync(sequencePath, Buffer.from(`${buildSequence}\n`, 'utf8'));
  const builtAtUtc = new Date().toISOString();
  const sourceDigest = sourceTreeDigest();
  const commit = gitCommit();
  const timestamp = builtAtUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const buildId = `${sourceDigest.slice(0, 12)}-${timestamp}-${String(buildSequence).padStart(6, '0')}`;
  const meta = {
    buildId,
    sourceDigest,
    gitCommit: commit,
    builtAtUtc,
    buildSequence
  };
  const distRoot = resolve(projectRoot, 'dist');
  mkdirSync(distRoot, { recursive: true });
  writeFileSync(resolve(distRoot, 'build-identity.json'), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  return meta;
}

const buildMeta = createBuildIdentity();
const buildDefines = {
  __CHATX2_BUILD_ID__: JSON.stringify(buildMeta.buildId),
  __CHATX2_BUILD_META__: JSON.stringify(buildMeta)
};

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  define: buildDefines,
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src', 'index.html'),
        'desktop-avatar': resolve(__dirname, 'src', 'desktop-avatar.html'),
        composer: resolve(__dirname, 'src', 'composer.html')
      }
    }
  },
  plugins: [
    electron([
      {
        entry: resolve(__dirname, 'electron/main.ts'),
        vite: {
          define: buildDefines,
          build: {
            outDir: resolve(__dirname, 'dist/electron'),
            rollupOptions: {
              external: ['electron', 'three']
            }
          }
        }
      },
      {
        entry: resolve(__dirname, 'electron/preloads/chat-preload.ts'),
        onstart({ reload }) {
          reload();
        },
        vite: {
          define: buildDefines,
          build: {
            outDir: resolve(__dirname, 'dist/electron'),
            rollupOptions: {
              output: {
                entryFileNames: 'chat-preload.js'
              }
            }
          }
        }
      },
      {
        entry: resolve(__dirname, 'electron/preloads/avatar-preload.ts'),
        onstart({ reload }) {
          reload();
        },
        vite: {
          define: buildDefines,
          build: {
            outDir: resolve(__dirname, 'dist/electron'),
            rollupOptions: {
              output: {
                entryFileNames: 'avatar-preload.js'
              }
            }
          }
        }
      },
      {
        entry: resolve(__dirname, 'electron/preloads/composer-preload.ts'),
        onstart({ reload }) {
          reload();
        },
        vite: {
          define: buildDefines,
          build: {
            outDir: resolve(__dirname, 'dist/electron'),
            rollupOptions: {
              output: {
                entryFileNames: 'composer-preload.js'
              }
            }
          }
        }
      }
    ]),
    renderer()
  ],
  server: {
    port: 5173,
    strictPort: true
  }
});
