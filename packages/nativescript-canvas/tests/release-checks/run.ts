#!/usr/bin/env node
// The @nativescript/canvas binding's release checks: the compiler finds it through this package
// (nativescript.compilerBinding), applies it to an app of a version it binds, and every file it names is here. They run
// on the compiler's harness with this suite (suite.json), the compiler a checkout linked into the workspace:
//   npm run test:release-checks
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appBindings } from '@nstudio/nativescript-compiler/src/plugins/bindings.ts';
import { check, finish } from '@nstudio/nativescript-compiler/tests/release-checks/checks.ts';

const message = (f: () => unknown) => { try { f(); return ''; } catch (e) { return (e as Error).message; } };

// ---- An app using @nativescript/canvas ----
(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-release-checks-canvas-'));
  /** The app depending on the plugin, installed at `version`. */
  const app = (version: string) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'canvas-app', dependencies: { '@nativescript/canvas': version } }));
    mkdirSync(join(dir, 'node_modules', '@nativescript', 'canvas'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@nativescript', 'canvas', 'package.json'), JSON.stringify({ name: '@nativescript/canvas', version, nativescript: {} }));
    return dir;
  };
  try {
    const [b] = appBindings(app('3.0.0-alpha.14'), 'android').filter((x) => x.package === '@nativescript/canvas');
    check(b?.name === '@triniwiz/compiled-nativescript-canvas', 'an app depending on @nativescript/canvas builds over this binding');
    check(!!b?.ios && statSync(b.ios.dir).isDirectory() && !!b.ios.conditions && existsSync(b.ios.conditions) && readFileSync(join(b.ios.dir, 'CanvasModule.swift'), 'utf8').includes(b.ios.installer), "the iOS binding's sources, conditions and installer are here");
    const a = b?.android;
    check(!!a && existsSync(a.script) && statSync(a.kotlin).isDirectory() && existsSync(join(a.jni, 'CMakeLists.txt')) && a.links.every((l) => readFileSync(join(a.jni, 'CMakeLists.txt'), 'utf8').includes(`\${${l.define}}`)), "the Android binding's script, Kotlin, JNI project and the libraries it links are here");
    check(message(() => appBindings(app('2.0.0'), 'android')).includes('binds @nativescript/canvas ^3.0.0-alpha.10, and the app has @nativescript/canvas 2.0.0'), 'a version of the plugin it does not bind is refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

finish();
