// Release guards, run on the development machine.
//
// This extension is published to strangers from a public repository, so three
// things are checked before publishing:
//
//   1. no tracked source file carries a site-specific default or a
//      credential-shaped string;
//   2. the build output in dist/ carries neither (a stale bundle would
//      otherwise ship one even after the source was fixed);
//   3. dist/manifest.json is the MV3 manifest with the host permissions the
//      extension needs.
//
// These three checks previously lived only in .github/workflows/ci.yml, which
// never executed. GitHub Actions is not part of this project's verification
// (ENG-180), so they live here instead — the same checks, run locally, with no
// third-party dependency and no network access.
//
// Usage: npm run verify   (or `npm run gate` for the whole local gate)
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // extension/
const repoRoot = path.dirname(root);
const dist = path.join(root, 'dist');

// Site-specific defaults and credential shapes. Identical to the pattern the
// removed workflow used, so nothing a hosted run would have caught is missed.
const FORBIDDEN = 'abertay|mylearningspace|sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|x-api-key: [A-Za-z0-9]';

// CHANGELOG.md describes the removed site-specific default on purpose, and this
// file contains the pattern itself. Neither is shipped code.
const EXCLUDED_PATHS = ['CHANGELOG.md', 'extension/scripts/verify-sources.mjs'];

// Names that must not appear in the built bundle at all.
const BUNDLE_FORBIDDEN = /abertay|mylearningspace/i;

let failed = 0;

function pass(name, detail) {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  failed = 1;
  console.error(`FAIL  ${name}`);
  if (detail) console.error(detail.replace(/^/gm, '      '));
}

// --- 1. tracked sources -----------------------------------------------------
// `git grep` reads tracked files only, which is the point: untracked scratch
// files and node_modules must not be able to fail or pass this check.
try {
  const args = ['grep', '-nIE', FORBIDDEN, '--', '.', ...EXCLUDED_PATHS.map((p) => `:!${p}`)];
  const matches = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  // git grep exits 0 only when it found something, and then the matches are on
  // stdout.
  fail(
    'tracked sources',
    `${matches.trim()}\n\nRemove it, or exclude the file here if it is a deliberate record: the extension ships to strangers and must stay vendor-neutral.`,
  );
} catch (err) {
  if (err.status === 1) {
    pass('tracked sources', 'no site-specific default, no credential-shaped string');
  } else {
    fail('tracked sources', `git grep could not run: ${err.stderr || err.message}`);
    console.error('      This check needs a git checkout — run it from a clone, not an exported tarball.');
  }
}

// --- 2. built bundle --------------------------------------------------------
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

try {
  await stat(path.join(dist, 'manifest.json'));
} catch {
  fail('built bundle', 'extension/dist/manifest.json is missing — build first: npm run build');
  process.exit(1);
}

const offenders = [];
for (const file of await walk(dist)) {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (BUNDLE_FORBIDDEN.test(text)) offenders.push(path.relative(root, file));
}
if (offenders.length > 0) {
  fail('built bundle', `${offenders.join('\n')}\n\ndist/ is stale — rebuild before publishing: npm run build`);
} else {
  pass('built bundle', 'no site-specific default in dist/');
}

// --- 3. built manifest ------------------------------------------------------
try {
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const problems = [];
  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
  }
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes('<all_urls>')) {
    problems.push('host_permissions does not include <all_urls>');
  }
  if (problems.length > 0) fail('built manifest', problems.join('\n'));
  else pass('built manifest', `MV3, version ${manifest.version}`);
} catch (err) {
  fail('built manifest', `could not read dist/manifest.json: ${err.message}`);
}

console.log(
  failed === 0
    ? '\nverify PASS: sources, bundle and manifest are clean and current.'
    : '\nverify FAIL: fix the checks above before publishing.',
);
process.exit(failed);
