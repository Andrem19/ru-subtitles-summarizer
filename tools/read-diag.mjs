// Read the newest diagnostic ring buffer per key from Brave's LevelDB log.
// Usage: node read-diag.mjs <Local Extension Settings dir> <key> [key...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const keys = process.argv.slice(3);
if (!dir || keys.length === 0) {
  console.error('usage: node read-diag.mjs <dir> <key> [key...]');
  process.exit(2);
}

const skip = /^(LOCK|CURRENT|MANIFEST|LOG)/;
const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    if (skip.test(name)) continue;
    const p = join(d, name);
    try {
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    } catch {
      /* locked */
    }
  }
})(dir);

const blobs = [];
for (const f of files) {
  try {
    blobs.push(readFileSync(f).toString('utf8'));
  } catch {
    /* locked */
  }
}

function arraysWith(text, key) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf(key, i)) >= 0) {
    const start = text.indexOf('[', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = start;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    try {
      const arr = JSON.parse(text.slice(start, j + 1));
      if (Array.isArray(arr)) out.push(arr);
    } catch {
      /* not a complete record */
    }
    i = j + 1;
  }
  return out;
}

for (const key of keys) {
  const all = blobs.flatMap((b) => arraysWith(b, key));
  const best = all.sort((a, b) => b.length - a.length)[0];
  console.log(`=== ${key} (snapshots ${all.length}, longest ${best ? best.length : 0}) ===`);
  if (best) for (const line of best) console.log('  ' + line);
  else console.log('  (nothing found)');
}
