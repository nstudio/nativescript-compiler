#!/usr/bin/env node
// Local release script to bootstrap-publish @nstudio/nativescript-compiler and all 6 public
// framework adapters to npm (e.g. for initial package creation before attaching npm OIDC
// Trusted Publishers).
//
// Usage:
//   npm run publish:local -- [--version <ver>] [--tag <alpha|next|latest>] [--core-repo <path>]
//                            [--otp <6-digit-code>] [--skip-kits] [--dry-run]
//
// Examples:
//   # Verify everything end-to-end without publishing:
//   npm run publish:local -- --version 9.2.0-alpha.10 --tag alpha --dry-run
//
//   # Publish all 7 packages to npm under @alpha:
//   npm run publish:local -- --version 9.2.0-alpha.10 --tag alpha
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCoreRepo } from './core-repo.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npm run publish:local -- [options]

Options:
  --version <ver>     Sync all packages + peerDependencies to <ver> before packing
  --tag <dist-tag>    npm dist-tag (default: alpha)
  --core-repo <path>  Path to NativeScript/NativeScript checkout for kit generation
  --otp <code>        Optional npm 2FA one-time password
  --rebuild-kits      Force regenerating Swift & Kotlin kits even if already present
  --skip-kits         Reuse already-generated Swift & Kotlin kits in packages/compiler
  --dry-run           Generate kits, build, and pack without running npm publish
`);
  process.exit(0);
}

const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const tag = opt('--tag', 'alpha');
const versionArg = opt('--version', undefined);
const coreRepoArg = opt('--core-repo', undefined);
const otp = opt('--otp', undefined);
const skipKits = args.includes('--skip-kits');
const rebuildKits = args.includes('--rebuild-kits');
const dryRun = args.includes('--dry-run');

const ADAPTERS = ['angular', 'vue', 'svelte', 'react', 'solid', 'octane'];

function run(cmd, cmdArgs, options = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, ...options });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function capture(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', cwd: root, ...options });
}

// 1. Check npm login (unless dry-run)
if (!dryRun) {
  const who = capture('npm', ['whoami']);
  if (who.status !== 0) {
    console.error('Not logged in to npm. Run `npm login` first, then re-run this script.');
    process.exit(1);
  }
  console.log(`npm user: ${who.stdout.trim()}`);
}

// 2. Resolve NativeScript core repo & ensure kits exist (or generate them)
const coreRepo = resolveCoreRepo(root, coreRepoArg);
let coreVersion;
if (coreRepo) {
  coreVersion = JSON.parse(readFileSync(join(coreRepo, 'packages', 'core', 'package.json'), 'utf8')).version;
  console.log(`NativeScript core repo: ${coreRepo} (@nativescript/core ${coreVersion})`);
}

const iosManifest = join(root, 'packages/compiler/kit-apple/Sources/NativeScriptKit/Core/manifest.json');
const androidManifest = join(root, 'packages/compiler/kit-android/generated/manifest.json');
const kitsPresent = existsSync(iosManifest) && existsSync(androidManifest);
const shouldGenerateKits = !skipKits && (rebuildKits || !!coreRepoArg || !kitsPresent);

if (shouldGenerateKits) {
  if (!coreRepo) {
    console.error('Cannot locate NativeScript/NativeScript checkout for kit generation. Pass --core-repo <path> or set NS_CORE_REPO (or pass --skip-kits if kits are already generated).');
    process.exit(1);
  }
  if (!existsSync(join(coreRepo, 'dist', 'packages', 'core', 'index.d.ts'))) {
    console.log('Building @nativescript/core declarations...');
    run('npx', ['nx', 'run', 'core:build'], { cwd: coreRepo });
  }
  const kitEnv = { ...process.env, NS_CORE_REPO: coreRepo, NS_COMPILER_ADAPTERS: join(root, 'packages') };
  run('npm', ['run', 'kit'], { env: kitEnv });
  run('npm', ['run', 'kit:android'], { env: kitEnv });
} else {
  if (!kitsPresent) {
    console.error('--skip-kits was passed, but generated Swift or Kotlin kits are missing. Run without --skip-kits.');
    process.exit(1);
  }
  coreVersion = JSON.parse(readFileSync(iosManifest, 'utf8')).core;
  console.log(`Reusing existing kits (generated from @nativescript/core ${coreVersion}); pass --rebuild-kits to regenerate.`);
}

// 3. Sync version across compiler + all adapters if --version was given
if (versionArg) {
  const syncArgs = ['scripts/set-version.mjs', versionArg];
  if (coreVersion) syncArgs.push('--core-version', coreVersion);
  run(process.execPath, syncArgs);
}

const compilerPkg = JSON.parse(readFileSync(join(root, 'packages', 'compiler', 'package.json'), 'utf8'));
const version = compilerPkg.version;
console.log(`\nTarget release: ${version} (dist-tag: ${tag})`);

// 4. Build compiler dist/types + all adapters (including Angular kit-index fragment)
run('npm', ['run', 'build']);

// 5. Pack all 7 public tarballs into a clean temp folder
const packDir = mkdtempSync(join(tmpdir(), 'nstudio-compiler-publish-'));
try {
  run(process.execPath, ['scripts/pack.mjs', packDir]);

  const tarballs = [
    { name: '@nstudio/nativescript-compiler', file: join(packDir, `nstudio-nativescript-compiler-${version}.tgz`) },
    ...ADAPTERS.map((fw) => ({
      name: `@nstudio/nativescript-compiler-${fw}`,
      file: join(packDir, `nstudio-nativescript-compiler-${fw}-${version}.tgz`),
    })),
  ];

  console.log('\nPacked tarballs:');
  for (const t of tarballs) {
    if (!existsSync(t.file)) {
      console.error(`Missing tarball: ${t.file}`);
      process.exit(1);
    }
    const mb = (statSync(t.file).size / (1024 * 1024)).toFixed(2);
    console.log(`  - ${t.name}@${version} (${mb} MB) -> ${t.file}`);
  }

  // 6. Publish compiler FIRST, then all 6 framework adapters
  const publishFlags = ['--access', 'public', '--tag', tag, ...(otp ? ['--otp', otp] : [])];
  if (dryRun) {
    console.log('\n[dry-run] Would run:');
    for (const t of tarballs) {
      console.log(`  npm publish ${t.file} ${publishFlags.join(' ')}`);
    }
    console.log('\nDry run complete — nothing was published.');
  } else {
    for (const t of tarballs) {
      console.log(`\nPublishing ${t.name}@${version} (${tag})...`);
      run('npm', ['publish', t.file, ...publishFlags]);
    }
    console.log(`
All 7 packages published under @${tag}!
Next step — configure npm Trusted Publishing (OIDC) on npmjs.com for each package:
  Package Settings -> Trusted Publisher -> GitHub Actions:
    Organization or user: nstudio
    Repository:           nativescript-compiler
    Workflow filename:    publish.yml
    Environment name:     npm-publish
`);
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
