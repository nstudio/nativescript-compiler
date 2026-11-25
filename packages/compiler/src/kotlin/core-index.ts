// The Android kit's index: kit-android's Kotlin sources read into kit types, for core's and for a plain program's translation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readNames, type KitMember, type KitType } from '../kit/kit-index.ts';
import { KIT_ANDROID } from '../driver/paths.ts';
import type { AdapterKit } from '../api/adapter-api.ts';
import { buildCache } from '../program/build-caches.ts';

/** The pseudo-type whose members are kit-android's public top-level functions (`getRootLayout`). */
export const TOP_LEVEL = '';
export const KIT = join(KIT_ANDROID, 'src/main/kotlin/org/nativescript/kit');

const runtimeIndexes = buildCache(new Map<string, Map<string, KitType>>());
/** The hand-written kit's types (with the build's adapter's Kotlin, `adapter`), for a plain program translated without core. */
export function runtimeKitIndex(adapter: Readonly<AdapterKit>): Map<string, KitType> {
	const sources = [KIT, ...(adapter.android ? [adapter.android] : [])];
	const key = sources.join('\n');
	return runtimeIndexes.get(key) ?? runtimeIndexes.set(key, kotlinKitIndex(sources)).get(key)!;
}
export const NATIVE_MEMBERS = new Set(['android', 'nativeView', 'nativeViewProtected']);
/** View methods whose arguments core reads as plain script objects. */
export const SCRIPT_OBJECTS = new Set(['animate', 'createAnimation', 'open', 'close', 'openShadeCover', 'closeShadeCover', 'showModal', 'closeModal']);

/**
 * Kotlin with each declaration on one line, as the index reads it: a line break inside parentheses (a signature or call
 * a formatter wrapped), or after a trailing `:` or `,` (a supertype list, a type on the next line), is a space.
 */
function joinContinuations(text: string): string {
	const out: string[] = [];
	let depth = 0;
	// The last character written that is not a space: a `:` there continues the line.
	let last = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
			out.push(text.slice(i, j + 1));
			last = c;
			i = j;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		if (c === '\n' && (depth > 0 || last === ':' || last === ',')) {
			while (text[i + 1] === ' ' || text[i + 1] === '\t') i++;
			if (out.at(-1) !== '(') out.push(' ');
			continue;
		}
		out.push(c);
		if (c !== ' ' && c !== '\t') last = c === '\n' ? '' : c;
	}
	return out.join('').replace(/,?\s+\)/g, ')');
}

/** A Java class's name: its package is the SDK's, AndroidX's, Java's or core's widgets'. */
const JAVA_PACKAGE = /^(?:android|androidx|java|javax|dalvik|org\.(?:nativescript\.widgets|json|w3c|xml)|com\.google)\.(?:[a-z_]\w*\.)*[A-Z]\w*$/;

/**
 * What kit-android offers translated code, read from its Kotlin sources: each
 * public class, object and interface, the class it extends, its public
 * members (a companion's or an object's are static), and the NativeScript
 * property names its `setProperty` handles (`"text" ->`).
 */
export function kotlinKitIndex(sources: string | string[]): Map<string, KitType> {
	const types = new Map<string, KitType>();
	// Extension members, made static once every file is read: those of an object (`Reactivity`), or of a companion.
	const extensions: { receiver: KitType; member: KitMember; companion: boolean }[] = [];
	const files = (Array.isArray(sources) ? sources : [sources]).flatMap((d) => (d.endsWith('.kt') ? [d] : existsSync(d) ? (readdirSync(d, { recursive: true }).sort() as string[]).filter((f) => f.endsWith('.kt')).map((f) => join(d, f)) : []));
	for (const f of files) {
		// Comments, not a string's `//` (`"file://"`), whose brace after it would be lost with it.
		// Block comments first: a doc comment may hold a `//` (a URL).
		let text = joinContinuations(
			readFileSync(f, 'utf8')
				.replace(/("(?:\\.|[^"\\\n])*")|\/\*[\s\S]*?\*\//g, (_, s) => s ?? '')
				.replace(/("(?:\\.|[^"\\\n])*")|\/\/.*$/gm, (_, s) => s ?? ''),
		);
		const imports = new Map([...text.matchAll(/^import\s+([\w.]+)\.(\w+)(?:\s+as\s+(\w+))?\s*$/gm)].map((m) => [m[3] ?? m[2], `${m[1]}.${m[2]}`]));
		// A Java class a generated file imports by its simple name is read as its alias (`android_view_View`), the name app
		// code imports it by (targets/android/build.ts), which no kit class shares.
		const java = new Map<string, string>();
		if (f.includes('/generated/kotlin/')) for (const [n, q] of imports) if (q.endsWith(`.${n}`) && JAVA_PACKAGE.test(q)) java.set(n, q.replace(/\./g, '_'));
		if (java.size) {
			const names = new RegExp(`("(?:\\\\.|[^"\\\\\\n])*")|(?<![\\w$.])(${[...java.keys()].join('|')})(?![\\w$])`, 'g');
			text = text.replace(names, (_, str, n) => str ?? java.get(n)!);
			for (const [n, alias] of java) imports.set(alias, imports.get(n)!);
		}
		// `path`: the declaration's name inside the classes enclosing it, public or not (`RegionPart.Nested`).
		const stack: { type: KitType | null; depth: number; companion: boolean; path?: string }[] = [];
		let depth = 0;
		for (const line of text.split('\n')) {
			const decl = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:open|abstract|final|data|sealed|enum|inner|private|internal|protected|public)\s+)*)(class|object|interface)\s+(\w+)(?:<[^>]*>)?(?:\s*(?:internal\s+|private\s+)?(?:constructor\s*)?\([^)]*\))?(?:\s*:\s*([\w.]+))?/.exec(line);
			const companion = /^\s*companion\s+object\b/.test(line);
			if ((decl || companion) && line.includes('{')) {
				if (companion) {
					stack.push({ type: [...stack].reverse().find((x) => x.type)?.type ?? null, depth, companion: true });
				} else {
					const isPublic = !/\b(private|internal|protected)\b/.test(decl![1]);
					const name = decl![3];
					let type = types.get(name) ?? null;
					const base = decl![2] === 'class' && decl![4] ? decl![4] : null;
					const outer = [...stack].reverse().find((x) => !x.companion)?.path;
					if (!type && isPublic) {
						type = { name, base, members: new Map(), props: new Set() };
						types.set(name, type);
						if (outer) type.outer = outer;
					}
					// Extension members in a file read earlier made the entry: the class declaration names the base.
					if (type && base) type.base = base;
					if (type && decl![2] === 'object') (type as KitType & { object?: boolean }).object = true;
					if (type && decl![2] === 'interface') (type as KitType & { iface?: boolean }).iface = true;
					if (type && f.includes('/generated/kotlin/')) type.core = true;
					if (type && decl![2] === 'class' && /\b(open|abstract)\b/.test(decl![1])) type.open = true;
					stack.push({ type: isPublic ? type : null, depth, companion: false, path: outer ? `${outer}.${name}` : name });
				}
			} else {
				// Extension members (`val Color.hex`, `fun Color.Companion.js(`, `val EffectOrder.Scope.view`) belong to their
				// receiver, a nested class by its own name as the index has it.
				const ext = depth === 0 ? /^(?:inline\s+)?(val|var|fun)\s+(?:<[^>]*>\s*)?((?:\w+\.)*\w+)\.(\w+)/.exec(line) : null;
				if (ext) {
					const path = ext[2].split('.');
					const companion = path.at(-1) === 'Companion';
					const name = path.at(companion ? -2 : -1)!;
					const receiver = types.get(name) ?? { name, base: null, members: new Map(), props: new Set() };
					types.set(name, receiver);
					const after = line.slice(ext.index + ext[0].length);
					const [params, rest] = ext[1] === 'fun' && /^\s*\(/.test(after) ? parenthesized(after, after.indexOf('(') + 1) : [undefined, after];
					const member: KitMember = { kind: ext[1] === 'fun' ? 'func' : 'var', static: companion, type: (/^\s*:\s*([^={]+)/.exec(rest)?.[1] ?? '').trim().replace(/\s+get\(\).*$/, '') || 'Unit', params };
					add(receiver, ext[3], member);
					extensions.push({ receiver, member, companion });
				}
				const top = depth === 0 && !ext ? /^(?:@\w+\s+)*(?:lateinit\s+)?(?:val|var)\s+`?(\w+)`?\s*:\s*([^={]+)/.exec(line) : null;
				if (top) {
					const global = types.get(TOP_LEVEL) ?? { name: TOP_LEVEL, base: null, members: new Map(), props: new Set() };
					types.set(TOP_LEVEL, global);
					add(global, top[1], { kind: 'var', static: true, type: top[2].trim() });
				}
				const fn = depth === 0 && !ext ? /^(?:inline\s+)?fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/.exec(line) : null;
				if (fn) {
					const global = types.get(TOP_LEVEL) ?? { name: TOP_LEVEL, base: null, members: new Map(), props: new Set() };
					types.set(TOP_LEVEL, global);
					// Parameters of function types (`callback: (ViewBase) -> Boolean`) nest parentheses.
					const [params, rest] = parenthesized(line, fn.index + fn[0].length);
					add(global, fn[1], { kind: 'func', static: true, type: (/^\s*:\s*([^={]+)/.exec(rest)?.[1] ?? 'Unit').trim(), params });
				}
				const owner = stack.at(-1);
				const enclosing = [...stack].reverse().find((x) => x.type)?.type;
				if (enclosing && /^\s*"\w+"(\s*,\s*"\w+")*\s*->/.test(line)) for (const m of line.matchAll(/"(\w+)"/g)) enclosing.props.add(m[1]);
				if (enclosing) for (const n of readNames(line)) enclosing.props.add(n);
				if (owner?.type && depth === owner.depth + 1 && !/\b(private|internal)\b/.test(line) && (!/\bprotected\b/.test(line) || /\b(open|override|abstract)\b/.test(line))) {
					const isStatic = owner.companion || !!(owner.type as KitType & { object?: boolean }).object;
					let m: RegExpExecArray | null;
					const made = /^\s*override\s+fun\s+createNativeView\(\)\s*:\s*NativeView\s*=\s*([\w.]+)\(/.exec(line);
					// A constructor taking script's arguments as one list (`constructor(__arguments: JSArray<Any?>)`).
					if (/^\s*constructor\(\s*__arguments\s*:\s*JSArray<Any\?>\s*\)/.test(line)) add(owner.type, '<init>', { kind: 'func', static: false, type: owner.type.name, params: '__arguments: JSArray<Any?>' });
					if (/^\s*constructor\(\s*\)/.test(line)) add(owner.type, '<init0>', { kind: 'func', static: false, type: owner.type.name, params: '' });
					const ctor = /^\s*(?:(?:public|protected)\s+)?constructor\(/.exec(line);
					if (ctor) add(owner.type, '<ctor>', { kind: 'func', static: false, type: owner.type.name, params: parenthesized(line, ctor.index + ctor[0].length)[0] });
					if (made) owner.type.native = imports.get(made[1]) ?? made[1];
					if ((m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:override|open|final|lateinit|const|abstract|protected|public)\s+)*(?:val|var)\s+`?(\w+)`?\s*:\s*([^={]+)/.exec(line))) add(owner.type, m[1], { kind: 'var', static: isStatic, type: m[2].trim().replace(/\s+get\(\).*$/, '') });
					else if ((m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:override|open|final|abstract|inline|operator|protected|public)\s+)*fun\s+(?:<[^>]*>\s*)?`?(\w+)`?\s*\(/.exec(line))) {
						const [params, rest] = parenthesized(line, m.index + m[0].length);
						add(owner.type, m[1], { kind: 'func', static: isStatic, type: (/^\s*:\s*([^={]+)/.exec(rest)?.[1] ?? 'Unit').trim(), params });
					}
				}
			}
			// A string's or a character literal's brace (`"{"`, `'{'`) opens or closes nothing.
			for (const ch of line.replace(/'(?:\\u[0-9a-fA-F]{4}|\\.|[^'\\])'/g, "' '").replace(/"(?:\\.|[^"\\])*"/g, '""')) {
				if (ch === '{') depth++;
				else if (ch === '}') {
					depth--;
					if (stack.length && stack.at(-1)!.depth === depth) stack.pop();
				}
			}
		}
	}
	for (const { receiver, member, companion } of extensions) member.static = companion || !!(receiver as KitType & { object?: boolean }).object;
	// Shorthands (`borderRadius`, `margin`) any view takes, expanded by a top-level function.
	for (const f of files) {
		const text = readFileSync(f, 'utf8');
		const at = text.indexOf('\nfun expandShorthand(');
		if (at < 0) continue;
		const body = text.slice(at, text.indexOf('\n}\n', at));
		for (const m of body.matchAll(/^\s*((?:"\w+"(?:,\s*)?)+)\s*->/gm)) for (const n of m[1].matchAll(/"(\w+)"/g)) types.get('View')?.props.add(n[1]);
	}
	return types;
}

/** The text up to the parenthesis closing the one before `start`, and the text after it. */
function parenthesized(line: string, start: number): [string, string] {
	let depth = 1;
	for (let i = start; i < line.length; i++) {
		if (line[i] === '(') depth++;
		else if (line[i] === ')' && --depth === 0) return [line.slice(start, i), line.slice(i + 1)];
	}
	return [line.slice(start), ''];
}

function add(type: KitType, name: string, member: KitMember) {
	const list = type.members.get(name) ?? [];
	list.push(member);
	type.members.set(name, list);
}
