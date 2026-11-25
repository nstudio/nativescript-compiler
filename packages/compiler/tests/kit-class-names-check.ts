#!/usr/bin/env node
// An app's references to a core class the generated kits name apart (`Source__debug_source`, as each runtime has a
// `Source`): construction, type positions, a base class, `instanceof`, static members and the class as a value, imported
// under its own name and another, translated for both platforms against the generated kits, name the kit's class.
//   node tests/kit-class-names-check.ts   (after `nx run compiler:kit` and `nx run compiler:kit-android`)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ANDROID } from '../src/driver/paths.ts';
import { kit, translateKotlin, translateSwift } from './native-build.ts';

const app = join(import.meta.dirname, 'kit-class-names', 'app.ts');
const kitName = 'Source__debug_source';
for (const generated of [join(kit, 'Core'), join(KIT_ANDROID, 'generated/kotlin')]) {
  if (!existsSync(generated)) {
    console.error(`${generated} is missing: generate the kits (nx run compiler:kit, nx run compiler:kit-android)`);
    process.exit(1);
  }
}
const out = mkdtempSync(join(tmpdir(), 'kit-class-names-'));
try {
  translateSwift([app], join(out, 'swift'), { copiesChecked: false });
  translateKotlin([app], join(out, 'kotlin'), 'app', { copiesChecked: false, generatedKit: true });
  for (const file of [join(out, 'swift', 'app.swift'), join(out, 'kotlin', 'app.kt')]) {
    const code = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|#sourceLocation)/.test(l)).join('\n');
    const bare = code.split('\n').filter((l) => /(?<![\w"])Source(?!__|\w)/.test(l));
    assert.deepEqual(bare, [], `${file}: core's Source named as the runtime's`);
    assert.ok((code.match(new RegExp(kitName, 'g')) ?? []).length >= 10, `${file}: ${kitName} at every reference`);
  }
  console.log(`kit class names: core's Source is ${kitName} in Swift and Kotlin`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
