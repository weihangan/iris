import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const electronPath = require.resolve('electron');
const mainJs = resolve(__dirname, 'dist/electron/main.js');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'electron',
      use: {
        // _electron 启动器在测试文件中直接使用
        ...devices['Desktop Chrome']
      }
    }
  ]
});
