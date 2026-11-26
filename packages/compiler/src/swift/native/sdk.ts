import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCache } from '../../program/build-caches.ts';
import type { NativeTable, NativeClass, NativeMethod, NativeProperty, NativeEnum, NativeFunction, NativeConstant, NativeStruct, SwiftType } from './sdk-types.ts';
import { tableCache, tables, nativeTable, categoryModules, upperFirst, tableKeys, sdk, TARGET } from './sdk-tables.ts';
export type { SwiftType, NativeMethod, NativeProperty, NativeClass, NativeEnum, NativeFunction, NativeConstant, NativeStruct, NativeTable } from './sdk-types.ts';
export { isSubframework, nativeTable, swiftTypeNames, categoryModule, iosTarget, moduleCache, setEmptyTable, registerDeclarationModule, moduleOfDeclaration, jsSelectorName } from './sdk-tables.ts';
export type { ScopedKind, TableOptions } from './sdk-tables.ts';

// ---------------------------------------------------------------- lookup

/** The modules whose tables are in the cache's folder, listed once. */
const cachedModules = buildCache(new Map<'', string[]>());

/** Every table generated so far, the given module's first. */
function allTables(first: string): NativeTable[] {
	let cached = cachedModules.get('');
	if (!cached) {
		const dir = tableCache();
		cached = existsSync(dir)
			? readdirSync(dir)
					.sort()
					.filter((f) => f.endsWith('.json'))
					.map((f) => f.slice(0, -5))
			: [];
		cachedModules.set('', cached);
	}
	const names = new Set([first, ...tables.keys(), ...cached]);
	return [...names].map((m) => nativeTable(m));
}

/** The module declaring a class or protocol, as seen from `module`. */
function homeOf(module: string, js: string): string | null {
	const t = nativeTable(module);
	const c = t.classes[js];
	if (c) return c.module;
	if (t.types?.[js]) return t.types[js];
	for (const other of allTables(module)) if (other.classes[js] && !other.classes[js].extension) return other.module;
	return null;
}

/** Whether a class, or a class it extends, conforms to a protocol (by their JavaScript names). */
export function conformsTo(module: string, jsClass: string, jsProtocol: string): boolean {
	for (const [js] of hierarchy(module, jsClass)) if (js === jsProtocol) return true;
	return false;
}

/** Whether a class, or a class it extends, conforms to a protocol Swift names `swiftProtocol`. */
export function conformsToSwift(module: string, jsClass: string, swiftProtocol: string): boolean {
	for (const [, c] of hierarchy(module, jsClass)) if (c.kind === 'protocol' && c.swift === swiftProtocol) return true;
	return false;
}

/** A class's entries by JavaScript name, breadth first: itself (with its categories from other modules), then its superclasses and protocols. */
function* hierarchy(module: string, jsClass: string): Generator<[string, NativeClass]> {
	const seen = new Set<string>();
	const queue: [string, string][] = [[module, jsClass]];
	while (queue.length) {
		const [from, js] = queue.shift()!;
		if (seen.has(js)) continue;
		seen.add(js);
		const home = homeOf(from, js);
		if (!home) continue;
		const main = nativeTable(home).classes[js];
		if (main) yield [js, main];
		for (const t of allTables(home)) {
			const c = t.classes[js];
			if (!c || c === main || !c.extension) continue;
			yield [js, c];
			for (const p of c.protocols ?? []) queue.push([t.module, p]);
		}
		if (main?.base) queue.push([home, main.base]);
		for (const p of main?.protocols ?? []) queue.push([home, p]);
	}
}

/** An initializer found on a superclass creates the receiving class. */
function rehome<T extends NativeMethod | NativeProperty>(m: T, found: NativeClass, receiver: NativeClass | null): T {
	if (m.kind !== 'init' || !receiver || found.swift === receiver.swift) return m;
	return sameModule({ ...m, returns: receiver.swift + (/[?!]$/.exec(m.returns)?.[0] ?? '') }, m);
}

function sameModule<T extends object>(copy: T, of: object): T {
	const module = categoryModules.get(of);
	if (module) categoryModules.set(copy, module);
	return copy;
}

type SwiftInit = NonNullable<NativeClass['swiftInits']>[number];

/** An overlay initializer called with the parameters `take` accepts, in order; every other parameter must have a default. */
function callSwiftInit(init: SwiftInit, take: (label: string | null) => boolean, complete: () => boolean): NativeMethod | null {
	const used: number[] = [];
	for (let i = 0; i < init.labels.length; i++) {
		if (take(init.labels[i])) used.push(i);
		else if (!init.defaults[i]) return null;
	}
	if (!complete()) return null;
	const { defaults, ...m } = init;
	return { ...m, labels: used.map((i) => init.labels[i]), params: used.map((i) => init.params[i]) };
}

function findInit(module: string, jsClass: string, own: (c: NativeClass) => NativeMethod | undefined, overlay: (init: SwiftInit) => NativeMethod | null): NativeMethod | null {
	const receiver = lookupClass(module, jsClass);
	for (const [, c] of hierarchy(module, jsClass)) {
		const m = own(c);
		if (m) return rehome(m, c, receiver);
		if (c.ownInits) break;
	}
	for (const [, c] of hierarchy(module, jsClass)) {
		for (const init of c.swiftInits ?? []) {
			const m = overlay(init);
			if (m) return rehome(m, c, receiver);
		}
		if (c.ownInits) break;
	}
	return null;
}

export function lookupClass(module: string, jsClass: string): NativeClass | null {
	const home = homeOf(module, jsClass);
	return home ? (nativeTable(home).classes[jsClass] ?? null) : null;
}

export function lookupMember(module: string, jsClass: string, jsMember: string, isStatic: boolean): NativeMethod | NativeProperty | null {
	const receiver = lookupClass(module, jsClass);
	let readonlyProp: NativeProperty | null = null;
	for (const [, c] of hierarchy(module, jsClass)) {
		const members = isStatic ? c.static : c.instance;
		const m = Object.hasOwn(members, jsMember) ? members[jsMember] : null;
		if (m) {
			if (m.kind === 'property' && m.readonly) {
				readonlyProp ??= rehome(m, c, receiver);
				continue;
			}
			return rehome(m, c, receiver);
		}
	}
	if (readonlyProp) return readonlyProp;
	if (!isStatic && !jsMember.startsWith('init') && cLong.test(jsMember)) return lookupMember(module, jsClass, jsMember.replace(cLong, 'LongLong'), false);
	if (!isStatic) return jsMember.startsWith('init') ? lookupInit(module, jsClass, jsMember) : null;
	// Swift drops a factory named after its class (`+[NSArray arrayWithArray:]`, `+[UIBezierPath bezierPath]`)
	// when an initializer has the same Swift name (`init(array:)`, `init()`).
	const factory = /^([A-Za-z][A-Za-z0-9]*?)(With[A-Z]\w*)?$/.exec(jsMember);
	if (!factory) return null;
	for (const [js] of hierarchy(module, jsClass)) {
		if (!js.endsWith(upperFirst(factory[1]))) continue;
		const init = lookupInit(module, jsClass, 'init' + (factory[2] ?? ''));
		return init && sameModule({ ...init, selector: init.selector || jsMember }, init);
	}
	return null;
}

export function lookupConstructor(module: string, jsClass: string, keys: string[]): NativeMethod | null {
	const key = keys.join(',');
	const sorted = [...keys].sort().join(',');
	return findInit(
		module,
		jsClass,
		(c) => c.constructors[key] ?? Object.entries(c.constructors).find(([k]) => k.split(',').sort().join(',') === sorted)?.[1],
		(init) => {
			let next = 0;
			return callSwiftInit(
				init,
				(label) => label === keys[next] && ++next > 0,
				() => next === keys.length,
			);
		},
	);
}

export function lookupInit(module: string, jsClass: string, jsInitName: string): NativeMethod | null {
	return ownInit(module, jsClass, jsInitName) ?? (cLong.test(jsInitName) ? ownInit(module, jsClass, jsInitName.replace(cLong, 'Integer')) : null);
}

/**
 * C's `long` in a selector (`initWithLong:`, `longValue`), which Swift imports no differently
 * from the 64-bit one beside it (`initWithInteger:`, `longLongValue`), so the table has only that.
 */
const cLong = /(?<!Long)Long(?!Long)(?=[A-Z]|$)/;

function ownInit(module: string, jsClass: string, jsInitName: string): NativeMethod | null {
	return findInit(
		module,
		jsClass,
		(c) => c.inits[jsInitName],
		(init) => {
			let rest = jsInitName.replace(/^init(With)?/, '');
			const take = (label: string | null) => {
				const word = upperFirst(label ?? '');
				if (!label || !rest.startsWith(word) || /^[a-z0-9]/.test(rest.slice(word.length))) return false;
				rest = rest.slice(word.length);
				return true;
			};
			return callSwiftInit(init, take, () => rest === '');
		},
	);
}

export function lookupEnum(module: string, jsEnum: string): NativeEnum | null {
	const found = allTables(module)
		.map((t) => t.enums[jsEnum])
		.filter(Boolean);
	if (!found.length) return null;
	if (found.length === 1 || found[0].kind !== 'typedConstants') return found[0];
	// Typed constants of one type are spread over the modules that declare them.
	const home = found.find((e) => e.raw) ?? found[0];
	return { ...home, cases: Object.assign({}, ...found.map((e) => e.cases)) };
}

function lookupIn<K extends 'functions' | 'constants' | 'structs'>(module: string, kind: K, js: string): NativeTable[K][string] | null {
	for (const t of allTables(module)) if (Object.hasOwn(t[kind], js)) return t[kind][js] as NativeTable[K][string];
	return null;
}

export function lookupFunction(module: string, jsName: string): NativeFunction | null {
	const f = lookupIn(module, 'functions', jsName);
	// The C function as Swift's global of its name, which the module's overlay shadows with an unavailable one.
	const shadowed = overlayUnavailable(module)[jsName];
	return shadowed !== undefined && (!f || (f.kind === 'function' && f.swift === jsName)) ? shadowed.f : f;
}
export const lookupConstant = (module: string, jsName: string): NativeConstant | null => lookupIn(module, 'constants', jsName) ?? swiftUnavailable(module).constants[jsName] ?? null;

/** The module whose table has constant `jsName`, as seen from `module`: where a typed constant's enum is declared. */
export function constantModule(module: string, jsName: string): string | null {
	for (const t of allTables(module)) if (Object.hasOwn(t.constants, jsName)) return t.module;
	return null;
}

/** Why Swift has no `jsName` of SDK module `module` (Swift's own words where it has them), or null if Swift has it. */
export function unavailableReason(module: string, jsName: string): string | null {
	return overlayUnavailable(module)[jsName]?.reason ?? swiftUnavailable(module).reasons[jsName] ?? null;
}

export const lookupStruct = (module: string, jsName: string): NativeStruct | null => lookupIn(module, 'structs', jsName);

/** The type a Swift typedef name stands for (`TimeInterval` → `Double`), through chains of typedefs. */
export function lookupTypealias(module: string, swiftName: string): SwiftType | null {
	let found: SwiftType | null = null;
	for (let name = swiftName, depth = 0; depth < 8; depth++) {
		const next = allTables(module)
			.map((t) => t.typealiases?.[name])
			.find(Boolean);
		if (!next) break;
		found = name = next;
	}
	return found;
}

// ---------------------------------------------------------------- declarations Swift does not import

const isSdkFramework = (module: string) => !tableKeys.has(module) && /^[A-Z]\w*$/.test(module) && existsSync(join(sdk().path, 'System', 'Library', 'Frameworks', `${module}.framework`));

/** The functions a module's Swift overlay redeclares unavailable, which hide the C functions of their names from Swift. */
const overlays = buildCache(new Map<string, Record<string, { f: NativeFunction | null; reason: string }>>());
function overlayUnavailable(module: string): Record<string, { f: NativeFunction | null; reason: string }> {
	let found = overlays.get(module);
	if (found) return found;
	overlays.set(module, (found = {}));
	const arch = TARGET.split('-')[0];
	const file = join(sdk().path, 'System', 'Library', 'Frameworks', `${module}.framework`, 'Modules', `${module}.swiftmodule`, `${arch}-apple-ios-simulator.swiftinterface`);
	if (!isSdkFramework(module) || !existsSync(file)) return found;
	const text = readFileSync(file, 'utf8');
	const unqualified = (t: string) =>
		t
			.trim()
			.replace(/\b\w+::/g, '')
			.replace(/^Swift\.|(?<=[^\w.])Swift\./g, '');
	for (const m of text.matchAll(/^@available\(\*, unavailable((?:, \w+: "(?:[^"\\]|\\.)*")*)\)\n(?:@\w.*\n)*public func (\w+)\(([^)]*)\)(?: -> (.+))?$/gm)) {
		const [, args, name, paramList, result = 'Void'] = m;
		const message = /\bmessage: "((?:[^"\\]|\\.)*)"/.exec(args)?.[1] ?? '';
		const renamed = /\brenamed: "((?:[^"\\]|\\.)*)"/.exec(args)?.[1];
		const params = paramList ? paramList.split(',').map((p) => unqualified(p.slice(p.indexOf(':') + 1))) : [];
		const equality = message === 'Use == instead' && params.length === 2 && params[0] === params[1] && unqualified(result) === 'Bool';
		found[name] = {
			f: equality ? { kind: 'equal', swift: '==', labels: [null, null], params, returns: 'Bool' } : null,
			reason: renamed ? `renamed in Swift to ${renamed}` : message ? `unavailable in Swift: ${message}` : 'unavailable in Swift',
		};
	}
	return found;
}

/**
 * A module's C constants that Swift does not import though Objective-C (and NativeScript's metadata) has them: marked
 * `NS_SWIFT_UNAVAILABLE` or `Availability: nonswift` in API notes, or deprecated by iOS 7 (unavailable in Swift by its
 * own rule). A string or integer one is its value, as the SDK gives it: read from a Mac Catalyst build of the module.
 */
interface UnavailableTable {
	format: number;
	constants: Record<string, NativeConstant>;
	reasons: Record<string, string>;
}
const UNAVAILABLE_FORMAT = 1;
const unavailableTables = buildCache(new Map<string, UnavailableTable>());
function swiftUnavailable(module: string): UnavailableTable {
	let table = unavailableTables.get(module);
	if (table) return table;
	table = { format: UNAVAILABLE_FORMAT, constants: {}, reasons: {} };
	unavailableTables.set(module, table);
	if (!isSdkFramework(module)) return table;
	const file = join(tableCache(), `${module}.unavailable.json`);
	if (existsSync(file)) {
		const cached = JSON.parse(readFileSync(file, 'utf8')) as UnavailableTable;
		if (cached.format === UNAVAILABLE_FORMAT) {
			unavailableTables.set(module, cached);
			return cached;
		}
	}
	const dir = mkdtempSync(join(tmpdir(), `unavailable-${module}-`));
	try {
		const found = unavailableConstants(module, dir);
		if (!found) return table;
		const values = found.size ? constantValues(module, [...found.values()], dir) : {};
		for (const [name, c] of found) {
			table.reasons[name] = c.reason;
			const k = values[name] === undefined ? null : constantOf(module, c, values[name]);
			if (k) table.constants[name] = k;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(table));
	return table;
}

interface UnavailableConstant {
	name: string;
	type: string;
	canonical: string;
	reason: string;
}

/** The module's constants Swift leaves out, by clang's reading of its headers and API notes; null if clang cannot read it. */
function unavailableConstants(module: string, dir: string): Map<string, UnavailableConstant> | null {
	let dump: string;
	try {
		dump = execFileSync('xcrun', ['clang', '-x', 'objective-c', '-target', TARGET, '-isysroot', sdk().path, '-fsyntax-only', '-fmodules', '-fapinotes-modules', `-fmodules-cache-path=${join(dir, 'modules')}`, '-Xclang', '-ast-dump-all', '-'], { input: `@import ${module};\n`, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
	} catch {
		return null;
	}
	const found = new Map<string, UnavailableConstant>();
	const lines = dump.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!/^[|`]-VarDecl /.test(lines[i])) continue;
		const head = / imported in ([\w.]+) (?:(?:hidden|used|referenced|implicit|invalid) )*(\w+) '([^']*)'(?::'([^']*)')?/.exec(lines[i]);
		if (!head || (head[1] !== module && !head[1].startsWith(`${module}.`))) continue;
		let reason: string | null = null;
		for (let j = i + 1; j < lines.length && /^[| ] /.test(lines[j]); j++) {
			const a = /^[| ] [|`]-AvailabilityAttr .*?> (\w+) ([\d.]+) ([\d.]+) ([\d.]+) (Unavailable )?"((?:[^"\\]|\\.)*)"/.exec(lines[j]);
			if (!a) continue;
			if (a[1] === 'swift' && a[5]) reason = a[6] ? `unavailable in Swift: ${a[6]}` : 'unavailable in Swift';
			else if (a[1] === 'ios' && a[3] !== '0' && parseFloat(a[3]) < 8 && !reason) reason = `deprecated in iOS ${a[3]}; APIs deprecated as of iOS 7 and earlier are unavailable in Swift`;
		}
		const plain = (t: string) =>
			t
				.replace(/\s*\b_(?:Nonnull|Nullable|Null_unspecified)\b/g, '')
				.replace(/^const /, '')
				.replace(/ \*\s*const$/, ' *');
		if (reason && !found.has(head[2])) found.set(head[2], { name: head[2], type: plain(head[3]), canonical: plain(head[4] ?? head[3]), reason });
	}
	return found;
}

const STRING_TYPE = /^(?:NSString|struct __CFString) \*$/;
const INTEGER_TYPES: Record<string, string> = {
	char: 'Int8',
	'signed char': 'Int8',
	'unsigned char': 'UInt8',
	short: 'Int16',
	'unsigned short': 'UInt16',
	int: 'Int32',
	'unsigned int': 'UInt32',
	long: 'Int',
	'unsigned long': 'UInt',
	'long long': 'Int64',
	'unsigned long long': 'UInt64',
};

/** The values of string and integer constants, from a Mac Catalyst program reading them; a constant Catalyst lacks has none. */
function constantValues(module: string, constants: UnavailableConstant[], dir: string): Record<string, string | number> {
	const mac = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
	const frameworks = join(mac, 'System', 'iOSSupport', 'System', 'Library', 'Frameworks');
	const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
	let wanted = constants.filter((c) => STRING_TYPE.test(c.canonical) || /^enum \w+$/.test(c.canonical) || INTEGER_TYPES[c.canonical]);
	for (let attempt = 0; attempt < 2 && wanted.length; attempt++) {
		const head = ['@import Foundation;', `@import ${module};`, 'int main(void) {', '  NSMutableDictionary *d = [NSMutableDictionary dictionary];'];
		const source = [...head, ...wanted.map((c) => `  d[@"${c.name}"] = ${c.canonical === 'NSString *' ? c.name : STRING_TYPE.test(c.canonical) ? `(__bridge NSString *)${c.name}` : `@((long long)${c.name})`};`), '  NSData *json = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];', '  fwrite(json.bytes, 1, json.length, stdout);', '  return 0;', '}', ''].join('\n');
		writeFileSync(join(dir, 'values.m'), source);
		const exe = join(dir, 'values');
		const built = spawnSync('xcrun', ['--sdk', 'macosx', 'clang', '-target', `${arch}-apple-ios17.0-macabi`, '-isysroot', mac, '-F', frameworks, '-fmodules', '-fobjc-arc', '-w', `-fmodules-cache-path=${join(dir, 'modules')}`, join(dir, 'values.m'), '-o', exe], { encoding: 'utf8' });
		if (built.status === 0) {
			try {
				return JSON.parse(execFileSync(exe, { encoding: 'utf8' }));
			} catch {
				return {};
			}
		}
		// Lines that do not compile (a name Catalyst does not declare): read the rest without them.
		const failed = new Set([...String(built.stderr).matchAll(/values\.m:(\d+):\d+: error/g)].map((m) => Number(m[1]) - head.length - 1));
		if (!failed.size) break;
		wanted = wanted.filter((_, k) => !failed.has(k));
	}
	return {};
}

function swiftLiteral(text: string): string {
	return (
		'"' +
		text
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u{${ch.charCodeAt(0).toString(16)}}`) +
		'"'
	);
}

/** A constant's value as Swift writes one of its type. */
function constantOf(module: string, c: UnavailableConstant, value: string | number): NativeConstant | null {
	const tag = /^enum (\w+)$/.exec(c.canonical)?.[1];
	const en = lookupEnum(module, c.type) ?? (tag ? lookupEnum(module, tag) : null);
	if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
	if (typeof value === 'string') {
		if (en?.kind === 'typedConstants' && en.swift) return { swift: `${en.swift}(rawValue: ${swiftLiteral(value)})`, type: en.swift };
		return c.canonical === 'NSString *' ? { swift: swiftLiteral(value), type: 'String' } : { swift: `(${swiftLiteral(value)} as CFString)`, type: 'CFString' };
	}
	if (en?.swift && en.kind === 'options') return { swift: value === 0 ? `${en.swift}([])` : `${en.swift}(rawValue: ${value})`, type: en.swift };
	if (en?.swift && en.kind === 'enum') return { swift: `${en.swift}(rawValue: ${value})!`, type: en.swift };
	const int = INTEGER_TYPES[c.canonical];
	return int ? { swift: `${int}(${value})`, type: int } : null;
}
