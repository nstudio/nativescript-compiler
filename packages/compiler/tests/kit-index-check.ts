#!/usr/bin/env node
// Every public type the kit's Swift declares, generated or hand-written, is one the kit manifest has, however
// swift-format laid its declaration out: the translator reaches a type the manifest lacks only by name, so its
// members fail at run time. So is every one a framework adapter's Swift declares, in the manifest with the adapter's
// fragment. A quick check before a build; kit-manifest-check.ts checks against the built module.
//   node tests/kit-index-check.ts [kit sources, default kit-apple/Sources/NativeScriptKit]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableAdapters, loadAdapter } from '../src/adapters/load.ts';
import { adapterKitOf } from '../src/adapters/active.ts';
import { adapterKitFragment, KIT_MANIFEST_FILE, readKitManifest, type KitManifest } from '../src/kit/manifest.ts';
import { readSwift } from '../src/kit/swift-declarations.ts';

const kit = process.argv[2] ?? join(import.meta.dirname, '..', 'kit-apple', 'Sources', 'NativeScriptKit');
const missing: string[] = [];
let declared = 0;
/** The public types `dir`'s Swift declares that `manifest` lacks. */
function check(manifest: KitManifest | null, dir: string, label: string) {
  if (!manifest) {
    console.error(`${kit}/Core has no kit manifest: generate the kit (nx run compiler:kit)`);
    process.exit(1);
  }
  for (const f of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.swift')).sort()) {
    for (const t of readSwift(readFileSync(join(dir, f), 'utf8')).types) {
      if (t.kind === 'extension' || t.access !== 'public') continue;
      declared++;
      if (!Object.hasOwn(manifest.types, t.name)) missing.push(`${label}${f}: ${t.name}`);
    }
  }
}
check(readKitManifest(kit, undefined), kit, '');
// The adapters are those $NS_COMPILER_ADAPTERS holds or tests/package.json lists (adapters/load.ts).
const stale: string[] = [];
for (const found of availableAdapters(import.meta.dirname)) {
  const dir = adapterKitOf(await loadAdapter(found)).apple;
  if (!dir) continue;
  check(readKitManifest(kit, dir), dir, `${found.framework} adapter: `);
  // What kit generation wrote beside the adapter's Swift is what an adapter's own build makes (ns-compiled-adapter kit-fragment).
  if (readFileSync(join(dir, KIT_MANIFEST_FILE), 'utf8') !== adapterKitFragment(kit, dir)) stale.push(join(dir, KIT_MANIFEST_FILE));
}
if (stale.length) {
  console.error(`index fragments ns-compiled-adapter kit-fragment makes otherwise from the kit:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
if (missing.length) {
  console.error(`the kit manifest lacks ${missing.length} type(s) the kit declares:\n  ${missing.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log(`kit manifest: all ${declared} public types the kit and its adapters declare`);
