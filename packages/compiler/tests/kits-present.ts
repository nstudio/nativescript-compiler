// Run before packing: the package ships both kits generated from core, from the same core release.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const kits = { iOS: 'kit-apple/Sources/NativeScriptKit/Core/manifest.json', Android: 'kit-android/generated/manifest.json' };
// Each kit's XML-free overlay, generated with it.
const overlays = { iOS: 'kit-apple/Overlays/xml-free/overlay.json', Android: 'kit-android/overlays/xml-free/overlay.json' };
const cores: Record<string, string> = {};
for (const [platform, file] of Object.entries(kits)) {
  for (const f of [file, overlays[platform as keyof typeof overlays]])
    if (!existsSync(join(root, f))) {
      console.error(`${f} is missing: generate the ${platform} kit (npx nx run compiler:${platform === 'iOS' ? 'kit' : 'kit-android'}) before packing`);
      process.exit(1);
    }
  cores[platform] = JSON.parse(readFileSync(join(root, file), 'utf8')).core;
}
if (cores.iOS !== cores.Android) {
  console.error(`the kits come from different cores: iOS ${cores.iOS}, Android ${cores.Android}`);
  process.exit(1);
}

// Every tracked file the kits build from must be in the tarball: the package's `files` list names folders one by one.
const packed = new Set(JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0].files.map((f: { path: string }) => f.path));
const tracked = execFileSync('git', ['ls-files', 'kit-apple', 'kit-android'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !basename(f).startsWith('.'));
const unpacked = tracked.filter((f) => !packed.has(f));
if (unpacked.length) {
  console.error(`${unpacked.length} kit files are not in the package's files list:\n${unpacked.join('\n')}`);
  process.exit(1);
}
console.log(`kits generated from @nativescript/core ${cores.iOS}`);
