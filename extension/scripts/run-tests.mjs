// Test runner: bundles tests/*.test.ts with esbuild, then runs node --test.
import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsDir = path.join(root, 'tests');
const outDir = path.join(root, 'build', 'tests');

const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.ts'));
if (files.length === 0) {
  console.error('No test files found in', testsDir);
  process.exit(1);
}

await build({
  entryPoints: files.map((f) => path.join(testsDir, f)),
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: 'inline',
  logLevel: 'warning',
});

const jsFiles = files.map((f) => path.join(outDir, f.replace(/\.ts$/, '.js')));
const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...jsFiles], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(res.status ?? 1);
