// Build script: bundles background/content/options into dist/ with esbuild.
import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
};

const entryPoints = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  options: 'src/options/options.ts',
};

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
  await cp(path.join(root, 'src', 'options', 'options.html'), path.join(dist, 'options.html'));
  await cp(path.join(root, 'src', 'options', 'options.css'), path.join(dist, 'options.css'));
  await cp(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true }).catch(() => {});
}

async function compile() {
  await build({
    ...common,
    entryPoints: Object.entries(entryPoints).map(([name, file]) => ({
      in: path.join(root, file),
      out: name,
    })),
    outdir: dist,
  });
  // note: iife output cannot contain top-level await — esbuild would fail on its own
}

if (watch) {
  let ctxs = await Object.entries(entryPoints).map(async ([name, file]) =>
    context({ ...common, entryPoints: [{ in: path.join(root, file), out: name }], outdir: dist }),
  );
  ctxs = await Promise.all(ctxs);
  await copyStatic();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[watch] watching for changes...');
} else {
  await copyStatic();
  await compile();
  console.log('[build] done ->', dist);
}
