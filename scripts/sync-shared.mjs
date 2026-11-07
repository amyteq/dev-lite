#!/usr/bin/env node
// Copy shared/ helpers into every plugin that ships them; --check fails on drift instead.
// Plugins are installed as separate caches, so each needs its own copy.
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const shared = join(root, 'shared');
const targets = ['dev-skills', 'dev-planning'].map((p) => join(root, 'plugins', p, 'scripts'));
const check = process.argv.includes('--check');

let drift = 0;
for (const file of readdirSync(shared)) {
  const source = readFileSync(join(shared, file));
  for (const dir of targets) {
    const target = join(dir, file);
    if (existsSync(target) && readFileSync(target).equals(source)) continue;
    if (check) {
      console.error(`drift: ${target} differs from shared/${file}`);
      drift += 1;
    } else {
      copyFileSync(join(shared, file), target);
      console.log(`synced ${target}`);
    }
  }
}
process.exit(drift ? 1 : 0);
