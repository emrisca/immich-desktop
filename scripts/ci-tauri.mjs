#!/usr/bin/env node
// The release workflow runs this instead of `tauri`, so the disk image that is
// about to be attached to a release is checked on the machine that built it.
//
// A dmg that will not mount, or an app inside it whose ad-hoc signature no
// longer matches its contents, is delivered as "damaged and can't be opened"
// and is invisible from here otherwise: 0.1.1 shipped that way.
//
//   node scripts/ci-tauri.mjs build --bundles dmg   proxy tauri, then verify
//   node scripts/ci-tauri.mjs verify [file.dmg]     verify only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundleDmg = 'src-tauri/target/release/bundle/dmg';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function newestDmg() {
  let names;
  try {
    names = readdirSync(bundleDmg).filter((name) => name.endsWith('.dmg'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const newest = names
    .map((name) => [name, statSync(path.join(bundleDmg, name)).mtimeMs])
    .sort((a, b) => b[1] - a[1])[0][0];
  return path.join(bundleDmg, newest);
}

function verify(dmg) {
  if (!dmg) fail(`no dmg to verify under ${bundleDmg}`);
  if (!statSync(dmg, { throwIfNoEntry: false })) fail(`${dmg} is not there`);

  const checksum = spawnSync('hdiutil', ['verify', dmg], { encoding: 'utf8' });
  if (checksum.status !== 0) fail(`${path.basename(dmg)} does not verify; it would arrive as damaged`);

  const mount = mkdtempSync(path.join(tmpdir(), 'immich-dmg-'));
  try {
    const attach = spawnSync(
      'hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg],
      { encoding: 'utf8' },
    );
    if (attach.status !== 0) fail(`${path.basename(dmg)} will not mount; it would arrive as damaged`);

    const app = readdirSync(mount).find((name) => name.endsWith('.app'));
    if (!app) fail('the image holds no app');

    const signed = spawnSync(
      'codesign',
      ['--verify', '--deep', '--strict', path.join(mount, app)],
      { encoding: 'utf8' },
    );
    if (signed.status !== 0) {
      console.error(signed.stderr.trim());
      fail(`the app inside ${path.basename(dmg)} does not satisfy its signature`);
    }
    process.stdout.write(signed.stderr);
  } finally {
    spawnSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
    rmSync(mount, { recursive: true, force: true });
  }

  const digest = spawnSync('shasum', ['-a', '256', dmg], { encoding: 'utf8' });
  console.log(`▸ ${path.basename(dmg)} verified`);
  console.log(`  ${digest.stdout.trim()}`);
  console.log('  put that digest in the release notes so a download can be checked');
}

const args = process.argv.slice(2);

if (args[0] === 'verify') {
  verify(args[1] ?? newestDmg());
  process.exit(0);
}

const tauri = spawnSync('npm', ['run', 'tauri', '--', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (tauri.status !== 0) process.exit(tauri.status ?? 1);

// Only a build produces an image, and only macOS has one to check.
if (process.platform === 'darwin' && args.includes('build')) verify(newestDmg());
