import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { root, seedPilot } from './seed-pilot.mjs';

// Several test processes consume the same generated, immutable auction fixture.
// Finish its first creation before Node starts those processes in parallel.
seedPilot();
const result = spawnSync(process.execPath, [
  '--test',
  ...process.argv.slice(2),
  ...globSync('tests/*.test.mjs', { cwd: root }).sort(),
], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
