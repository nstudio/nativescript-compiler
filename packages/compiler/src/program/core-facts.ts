// What both backends know of @nativescript/core apart from either kit's API: which declarations are core's or the
// compiler's shims, the native view a core class drives, which members core marks as view properties, and the plugins
// a build stubs.
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { kitMember, type KitType } from '../kit/kit-index.ts';
import { buildCache } from './build-caches.ts';

/** The native view a core class drives on iOS: what `view.ios` and `view.nativeView` are. */
export const NATIVE_VIEWS: Record<string, string> = {
	Label: 'UILabel',
	Button: 'UIButton',
	TextField: 'UITextField',
	TextView: 'UITextView',
	Image: 'UIImageView',
	Switch: 'UISwitch',
	Slider: 'UISlider',
	SegmentedBar: 'UISegmentedControl',
	ActivityIndicator: 'UIActivityIndicatorView',
	ScrollView: 'UIScrollView',
	ListView: 'UITableView',
	Progress: 'UIProgressView',
	DatePicker: 'UIDatePicker',
	TimePicker: 'UIDatePicker',
	WebView: 'WKWebView',
	View: 'UIView',
	HtmlView: 'UITextView',
	SearchBar: 'UISearchBar',
	ListPicker: 'UIPickerView',
};
/** What `ios` is where it is a view controller, whose `nativeView` is the controller's view. */
export const NATIVE_CONTROLLERS: Record<string, string> = { TabView: 'UITabBarController', Page: 'UIViewController' };
export const NATIVE_MEMBERS = new Set(['ios', 'nativeView', 'nativeViewProtected']);
/** View methods whose arguments core reads as plain script objects. */
export const SCRIPT_OBJECTS = new Set(['animate', 'createAnimation', 'open', 'close', 'openShadeCover', 'closeShadeCover', 'showModal', 'closeModal']);

const barrels = buildCache(new Map<string, Map<string, string>>());
/** `export * as Utils from './utils'` in core's index: folder → public name. */
export function coreBarrels(root: string): Map<string, string> {
	let names = barrels.get(root);
	if (names) return names;
	names = new Map();
	const index = join(root, 'index.d.ts');
	if (existsSync(index)) for (const m of readFileSync(index, 'utf8').matchAll(/^export \* as (\w+) from '\.\/([^'/]+)[^']*';/gm)) names.set(m[2], m[1]);
	barrels.set(root, names);
	return names;
}

/**
 * Whether a member's declarations are the program's own, adding it to a core type (an intersection's added members),
 * a plugin's declaration modules (`index.d.ts`) among them; native typings are global declarations.
 */
export function addedDeclarations(decls: readonly ts.Declaration[]): boolean {
	return decls.length > 0 && decls.every((d) => !isCoreDeclaration(d) && (!d.getSourceFile().isDeclarationFile || ts.isExternalModule(d.getSourceFile())));
}

/** A property core's typings declare that the kit's class lacks and leaves to each object's own properties (see `CoreAPI.ownPropertyOnly`). */
export function ownPropertyOnly(index: Map<string, KitType>, owner: string, name: ts.MemberName, sym: ts.Symbol | undefined): boolean {
	if (kitMember(index, owner, name.text) || !kitMember(index, owner, 'jsExpando')) return false;
	const decls = sym?.declarations ?? [];
	return decls.length > 0 && decls.every((d) => isCoreDeclaration(d) && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Static));
}

/**
 * A property only the program's or a plugin's declarations give a core class (`declare module` merging an interface
 * into View) that the kit's class lacks: each object's own property, as script's.
 */
export function augmentedProperty(index: Map<string, KitType>, owner: string, name: ts.MemberName, sym: ts.Symbol | undefined): boolean {
	if (kitMember(index, owner, name.text) || !kitMember(index, owner, 'jsExpando')) return false;
	const decls = sym?.declarations ?? [];
	return addedDeclarations(decls) && decls.every((d) => ts.isPropertySignature(d) && ts.isInterfaceDeclaration(d.parent));
}

/** A declaration of the compiler's own typings for the kit's hand-written API (program.ts's shims: a framework module's `ErrorHandler`). */
export function isShimDeclaration(decl: ts.Declaration | undefined): boolean {
	return !!decl && decl.getSourceFile().fileName.startsWith('/__shims__/');
}

/** A declaration of core's TypeScript API; the typings of its own native code (`objc!NativeScriptUtils.d.ts`) are native declarations. */
export function isCoreDeclaration(decl: ts.Declaration | undefined): boolean {
	const file = decl?.getSourceFile().fileName;
	return !!file && (/[\\/]@nativescript[\\/]core[\\/]/.test(file) || coreDeclarationFile(file)) && !/[\\/]objc![^\\/]+\.d\.ts$/.test(file);
}

/**
 * A declaration file of core by the package it is in, as Node finds the nearest package.json: where the package is not
 * under `node_modules/@nativescript/core` (core's own repository: `packages/core`, `dist/packages/core`).
 */
function coreDeclarationFile(file: string): boolean {
	return file.endsWith('.d.ts') && packageOf(file)?.name === '@nativescript/core';
}

const packages = buildCache(new Map<string, { name: string; root: string } | null>());
/** The package a file is in: the nearest package.json naming one. */
export function packageOf(file: string): { name: string; root: string } | null {
	const seen: string[] = [];
	let found: { name: string; root: string } | null = null;
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		if (packages.has(dir)) {
			found = packages.get(dir)!;
			break;
		}
		seen.push(dir);
		const manifest = join(dir, 'package.json');
		const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name : undefined;
		if (name) {
			found = { name, root: dir };
			break;
		}
		if (dirname(dir) === dir) break;
	}
	for (const d of seen) packages.set(d, found);
	return found;
}

/** A core symbol's name as the kit names it: a class exported as its module's default (`abortcontroller`) by the class's own name. */
export function coreSymbolName(sym: ts.Symbol): string {
	const decl = sym.declarations?.[0];
	return sym.name === 'default' && decl && ts.isClassDeclaration(decl) && decl.name ? decl.name.text : sym.name;
}

/** A member core's declarations mark as a view property (`@nsProperty`). */
export function isCoreProperty(decl: ts.Declaration): boolean {
	const file = decl.getSourceFile().fileName;
	return (/[\\/]@nativescript[\\/]core[\\/]/.test(file) || (file.endsWith('.d.ts') && packageOf(file)?.name === '@nativescript/core')) && ts.getJSDocTags(decl).some((t) => t.tagName.text === 'nsProperty');
}

/**
 * With `--allow-unimplemented-properties`, a core property the kit does not apply is
 * stored by name and does nothing, as in a template; otherwise it stops the build.
 */
export function unappliedProperty(t: { resolve(n: ts.Node): ts.Symbol | undefined; allowUnapplied: boolean; error(n: ts.Node, what: string): Error }, name: ts.MemberName, what: string, kit: string): void {
	const declared = (t.resolve(name)?.declarations ?? []).some(isCoreProperty);
	if (!declared || !t.allowUnapplied) throw t.error(name.parent, `${what} (${declared ? `core declares it, ${kit} does not apply it` : `not a property ${kit} applies`})`);
	const sf = name.getSourceFile();
	console.warn(`warning: ${sf.fileName}:${sf.getLineAndCharacterOfPosition(name.getStart()).line + 1}: ${what}: core declares it, ${kit} does not apply it`);
}

/** The native class a core class's `ios` is, walking up to the nearest one the table names. */
export function nativeViewOf(checker: ts.TypeChecker, type: ts.Type, table: Record<string, string> = NATIVE_VIEWS): string | null {
	const visit = (t: ts.Type): string | null => {
		const sym = t.getSymbol();
		if (!sym || !isCoreDeclaration(sym.declarations?.[0])) return null;
		if (table[sym.name]) return table[sym.name];
		for (const b of t.isClassOrInterface() ? checker.getBaseTypes(t) : []) {
			const found = visit(b);
			if (found) return found;
		}
		return null;
	};
	return visit(checker.getNonNullableType(type));
}
