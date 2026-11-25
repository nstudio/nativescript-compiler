// Values converted between script and native code: arguments into native parameters, native results into script's.
import ts from 'typescript';
import { BUFFER_SOURCE, INTEGERS, NUMBERS, base, blockType, bridge, integral, onlyTested, optional, posted, typedCollection, unwrapAs } from './bridging.ts';
import { nativeBridging, type BridgeClass } from '../../semantics/conversion.ts';
import { CF_CLASSES, balanced, functionParts, optionalType, RT } from '../syntax.ts';
import type { NativeAPI } from './api.ts';
import { conformsTo, lookupClass, lookupConstant, nativeTable, type SwiftType } from './sdk.ts';
import { argumentSlot, place } from '../../semantics/placement.ts';
import { isKit, isNamed, isUntyped, spelledType } from '../../semantics/types.ts';

export const nativeConversionsMethods = {
	argList(this: NativeAPI, call: ts.CallExpression | ts.NewExpression, args: readonly ts.Expression[], labels: (string | null)[], params: SwiftType[]): string {
		const out: string[] = [];
		let next = 0;
		params.forEach((type, k) => {
			const label = labels[k];
			// A `()` parameter (`init(toMemory: ())`) takes no JavaScript argument.
			const value = type === '()' ? '()' : next < args.length ? this.argument(call, args[next++], type) : null;
			if (value !== null) out.push(label ? `${label}: ${value}` : value);
		});
		for (; next < args.length; next++) out.push(this.argument(call, args[next], 'Any?', true));
		return out.join(', ');
	},

	/** `a` in the slot of a native parameter of `call` Swift types `type`, or past the parameters (`rest`), given as it is. */
	argument(this: NativeAPI, call: ts.CallExpression | ts.NewExpression, a: ts.Expression, type: SwiftType, rest = false): string {
		const k = call.arguments?.indexOf(a) ?? -1;
		return place(this.t.placement, a, argumentSlot(this.t.placement, type, undefined, { call, k, a: k < 0 ? undefined : a }, rest ? { native: {}, rest } : { native: {} }));
	},

	/** A typealias of a number (`AVAudioFrameCount`): the number type it names, which conversions know; any other type as it is. */
	numericAlias(this: NativeAPI, type: SwiftType): SwiftType {
		const b = base(type);
		if (NUMBERS.has(b) || !/^[A-Z]\w*$/.test(b)) return type;
		const u = base(this.unalias(b));
		return NUMBERS.has(u) ? type.replace(b, u) : type;
	},

	/** A TypeScript value where a Swift API takes `target`. */
	toSwift(this: NativeAPI, e: ts.Expression, target: SwiftType): string {
		target = this.numericAlias(target);
		const t = this.t;
		while ((ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) && ['any', 'unknown', 'never'].includes(e.type.getText())) e = e.expression;
		const b = base(target);
		// null for a collection Swift marks nonnull: the empty one, as Objective-C reads nil.
		// null for a struct: its zero value, as the runtime marshals it.
		if ((e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) && !optional(target) && this.isStructType(b)) return `${b}()`;
		if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return optional(target) || !b.startsWith('[') ? 'nil' : b.includes(':') ? '[:]' : '[]';
		if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return this.block(e, target);
		// A Promise executor's resolve as the completion (`getNotificationSettingsWithCompletionHandler(resolve)`): the promise resolved with its argument.
		const resolver = t.promiseResolver(e);
		const block = resolver ? blockType(this.unalias(target)) : null;
		if (resolver && block && block.result === 'Void' && block.params.length <= 1) {
			const value = resolver.type === 'Void' ? '' : block.params.length ? this.blockParam('__b0', block.params[0], resolver.type) : (t.zero(resolver.type) ?? 'nil');
			// Entering script as any block does: the SDK may call it off the main thread.
			return `${posted('Void', block.params) ? RT.jsEnter : RT.jsEnterAwaiting} { (${block.params.map((p, k) => `__b${k}: ${p}`).join(', ')}) -> Void in ${resolver.name}.resolve(${value}) }`;
		}
		const source = t.typeOf(e);
		// A native constant of the type Swift takes (`kCFAllocatorDefault`, which TypeScript types `any`): the constant itself.
		const constantOf = ts.isIdentifier(e) ? this.symbolModule(this.t.resolve(e)) : null;
		const typedConstant = constantOf && lookupConstant(constantOf.module, constantOf.name);
		if (typedConstant && base(typedConstant.type) === b) return typedConstant.swift;
		// A value Swift holds as optional though TypeScript types it present (a nullable parameter passed on): nil stays nil.
		const maybe = optional(target) && base(source) === b ? t.maybeUndefined(e) : null;
		if (maybe) return maybe;
		const bridged = bridge(t.expr(e), source, target);
		if (bridged) return bridged;
		const held = this.heldBlock(t.expr(e), source, target);
		if (held) return held;
		// An untyped value where Swift takes a string: a missing one reads as empty, as Objective-C reads nil; anything else as its string.
		if (isUntyped(spelledType(source)) && b === 'String') return optional(target) ? `${RT.jsNativeString}(${t.expr(e)})` : `${RT.jsStringOrEmpty}(${t.expr(e)})`;
		// An object where a protocol is taken (`recognizer.delegate = navigationController`): Objective-C asks the object whether it conforms.
		if (/^any [A-Z]\w*$/.test(b) && /^[A-Z][\w.]*[?!]?$/.test(source) && !this.isEnumType(base(source)) && !this.isStructType(base(source)) && !['Double', 'String', 'Bool'].includes(base(source))) return this.asProtocol(e, source, target, b, `(${t.expr(e)} as? ${b})${optional(target) ? '' : '!'}`);
		// An untyped value where Swift takes a BOOL: its truthiness, as the runtime marshals it.
		if (isUntyped(spelledType(source)) && b === 'Bool') return `${RT.jsTruthy}(${t.expr(e)})`;
		// A boolean or string held optional (declared `boolean | undefined`) where Swift takes one: a missing one as Objective-C reads nil.
		if (!optional(target) && (b === 'Bool' || b === 'String') && source === `${b}?`) return `(${t.expr(e)} ?? ${b === 'Bool' ? 'false' : '""'})`;
		// A dispatch queue, which TypeScript types as NSObject: the queue, cast.
		if (base(source) === 'NSObject' && (b === 'DispatchQueue' || base(this.unalias(b)) === 'DispatchQueue')) {
			return optional(target) ? this.t.marks.castCode(t.expr(e), b, 'as?') : this.t.marks.castCode(t.expr(e), b, 'as!');
		}
		// An ArrayBuffer or a typed array where Swift takes bytes: a copy of them, or their address, as the iOS runtime passes them.
		if (b === 'Data' && BUFFER_SOURCE.test(source)) return `${RT.jsNativeData}(${t.expr(e)})`;
		if (/^Unsafe(Mutable)?RawPointer$/.test(b) && BUFFER_SOURCE.test(source)) {
			const bytes = b === 'UnsafeRawPointer' ? `${RT.jsNativeBytes}(${t.expr(e)})` : `${RT.jsNativeBytes}(${t.expr(e)}).map { UnsafeMutableRawPointer(mutating: $0) }`;
			return this.t.marks.unwrappedIf(bytes, !optional(target));
		}
		// A script Date where Swift takes a Foundation Date: the same instant.
		if (b === 'Date' && base(source) === 'JSDate') return source.endsWith('?') ? this.t.marks.unwrappedIf(`${t.expr(e)}.map { ${RT.jsNativeDate}($0) }`, !optional(target)) : `${RT.jsNativeDate}(${t.expr(e)})`;
		// An untyped value where Swift takes a Foundation Date (`<any>date` of a `Date | NSDate`): whichever it holds.
		if (b === 'Date' && isUntyped(spelledType(source))) return optional(target) ? `${RT.jsNativeDate}(any: ${t.expr(e)})` : this.t.marks.unwrappedCode(`${RT.jsNativeDate}(any: ${t.expr(e)})`);
		// An out-parameter: the cell's storage of the pointee's type, written back.
		const pointee = /^UnsafeMutablePointer<(\w+)>$/.exec(b)?.[1];
		if (pointee && source === 'InteropReference') return `&${t.expr(e)}.${pointee === 'CGFloat' ? 'cgFloat' : pointee === 'Bool' || pointee === 'ObjCBool' ? 'bool' : NUMBERS.has(pointee) && pointee !== 'Double' ? 'int' : 'value'}`;
		if (source === 'InteropReference' && b === 'UnsafeMutablePointer<Unmanaged<CFError>?>') return `&${t.expr(e)}.cfError`;
		// An object out-parameter (`UnsafeMutablePointer<CFTypeRef?>`): the cell holds what the function writes, as its type.
		// The null pointer (`new interop.Pointer()`) where Swift takes a pointer: none.
		if (base(source) === 'InteropPointer' && (/^(Unsafe|AutoreleasingUnsafe|OpaquePointer)/.test(b) || b === 'NSErrorPointer') && (optional(target) || b === 'NSErrorPointer')) return 'nil';
		const objectPointee = b === 'NSErrorPointer' ? 'NSError' : /^(?:AutoreleasingUnsafeMutablePointer|UnsafeMutablePointer)<([A-Z][\w.]*)\?>$/.exec(b)?.[1];
		if (objectPointee && base(source) === 'InteropReference' && !NUMBERS.has(objectPointee) && !this.isStructType(objectPointee) && !this.isEnumType(objectPointee)) {
			return `&${t.expr(e)}${optional(source) ? '!' : ''}[pointee: ${objectPointee}.self]`;
		}
		const pointed = /^UnsafePointer<(\w+)>$/.exec(b)?.[1];
		if (pointed && this.isStructType(pointed) && (isUntyped(spelledType(source)) || base(source) === pointed)) return this.t.marks.unwrappedIf(`${RT.jsStructPointer}(${t.expr(e)}, ${pointed}.self)`, !optional(target));
		// By the function, not the type's initializer: core declares a class named Selector (CSS selectors).
		if (b === 'Selector' && ts.isStringLiteralLike(e)) return `NSSelectorFromString(${JSON.stringify(e.text + ':'.repeat(this.exposedArity(e.text)))})`;
		// A constant naming a method (`GestureEvents.touchDown`): its value, as a literal is; any other string as it is when it runs.
		if (b === 'Selector' && /^String\??$/.test(source)) {
			const literal = this.t.checker.getTypeAtLocation(e);
			if (literal.isStringLiteral()) return `NSSelectorFromString(${JSON.stringify(literal.value + ':'.repeat(this.exposedArity(literal.value)))})`;
			return `NSSelectorFromString(${t.expr(e)})`;
		}
		if (NUMBERS.has(b)) return this.bridged(e, source, target) ?? (ts.isNumericLiteral(e) ? t.expr(e) : `${RT.jsNativeNumber}(${t.expr(e)})`);
		if (this.isNumericConstants(b) && ['Double', 'Double?', 'Any?'].includes(source)) {
			const raw = this.typedConstantsRaw(b)!;
			if (source === 'Double') return `${b}(rawValue: ${integral(t.expr(e), raw)})`;
			if (isUntyped(spelledType(source))) return `${b}(rawValue: ${integral(`${RT.jsToNumber}(${t.expr(e)})`, raw)})`;
			return `(${t.expr(e)}).map { ${b}(rawValue: ${integral('$0', raw)}) }${optional(target) ? '' : ` ?? ${b}(rawValue: 0)`}`;
		}
		if (source === 'Double' && this.isEnumType(b)) {
			// A number where Swift takes an enum or option set: its raw value.
			const raw = this.rawTypeOf(b);
			return this.isOptionSet(b) ? `${b}(rawValue: ${integral(t.expr(e), raw)})` : `${RT.jsNativeEnum}(${b}.self, ${integral(t.expr(e), raw)})`;
		}
		// An untyped value where Swift takes a native enum or option set: the number the runtime marshals.
		if (isUntyped(spelledType(source)) && this.isEnumType(b)) return this.enumFromNumber(`${RT.jsToNumber}(${t.expr(e)})`, b);
		// A BOOL the runtime marshals from any value: its truthiness.
		if (isUntyped(spelledType(source)) && b === 'Bool') return `${RT.jsTruthy}(${t.expr(e)})`;
		// A string the runtime marshals from any value: its string, null and undefined as nil.
		if (isUntyped(spelledType(source)) && b === 'String') return optional(target) ? `${RT.jsNativeString}(${t.expr(e)})` : `${RT.jsToString}(${t.expr(e)})`;
		const bridged7 = base(source) === b ? null : this.bridged(e, source, target);
		if (bridged7 !== null) return bridged7;
		// An untyped value where Swift takes a native object (or one conforming to a protocol: `any UIInteraction`).
		const cls = b.replace(/^any /, '');
		if (isUntyped(spelledType(source)) && /^[A-Z]\w*$/.test(cls) && !this.isEnumType(cls) && !NUMBERS.has(cls) && cls !== 'String' && cls !== 'Bool') {
			if (CF_CLASSES.has(cls)) return optional(target) ? `${RT.jsForeign}(${t.expr(e)}, ${cls}.self)` : `${RT.jsForeignPresent}(${t.expr(e)}, ${cls}.self)`;
			// A geometry struct the runtime gives script as an object (`window.screen.bounds`): the struct again.
			if (['CGRect', 'CGSize', 'CGPoint', 'UIEdgeInsets'].includes(cls)) return optional(target) ? `${RT.jsNativeStruct}(${t.expr(e)}, ${cls}.self)` : `${RT.jsNativeStructPresent}(${t.expr(e)}, ${cls}.self)`;
			return optional(target) ? (b === 'Any' ? `${RT.jsFlat}(${t.expr(e)})` : `(${RT.jsFlat}(${t.expr(e)}) as? ${b})`) : `${RT.jsNativeObject}(${t.expr(e)}, ${b.startsWith('any ') ? `(${b})` : b}.self)`;
		}
		// An object where Swift takes one conforming to a protocol its class may not declare (a delegate the runtime would accept): checked when it runs.
		if (b.startsWith('any ') && source.replace(/[?!]$/, '') !== b && /^(\w+\.)?[A-Z]\w*$/.test(source.replace(/[?!]$/, '')) && base(source) !== 'String') return this.asProtocol(e, source, target, b, optional(target) ? this.t.marks.castCode(t.expr(e), b, 'as?') : this.t.marks.castCode(t.expr(e), b, 'as!'));
		if (/^NSMutable(Array|Dictionary)[?!]?$/.test(source) && b.startsWith('[')) {
			// Held implicitly unwrapped or not, alike; a missing one is nil where Swift takes an optional, else empty.
			const immutable = base(source).replace('Mutable', '');
			const cast = `(${t.expr(e)} as ${base(source)}?).map { ${typedCollection(`$0 as ${immutable}`, b) ?? `$0 as ${immutable} as! ${b}`} }`;
			return optional(target) ? cast : `(${cast} ?? ${b.includes(':') ? '[:]' : '[]'})`;
		}
		if (isKit(spelledType(source), 'JSArray') && b.startsWith('[') && !b.includes(':')) {
			if (ts.isArrayLiteralExpression(e) && !e.elements.length) return '[]';
			const array = source.endsWith('?') ? `(${t.expr(e)} ?? JSArray())` : t.expr(e);
			if (b === '[Any]') return `${array}.storage.map { $0 as Any }`;
			const from = source.replace(/\?$/, '').slice('JSArray<'.length, -1),
				to = b.slice(1, -1);
			if (from === to) return `${array}.storage`;
			if (from === 'Double' && NUMBERS.has(to)) return `${array}.storage.map { ${to}($0) }`;
			if (from === 'Double' && this.isEnumType(to)) return `${array}.storage.map { ${this.enumFromNumber('$0', to)} }`;
			return typedCollection(`${array}.storage`, b)!;
		}
		// An array typed loosely in TypeScript where Swift takes typed elements (`[UIBarButtonItemGroup]`).
		if (source === '[Any]' && b.startsWith('[') && b !== '[Any]') return typedCollection(t.expr(e), b) ?? this.t.marks.castCode(t.expr(e), b, 'as!');
		// An untyped value where Swift takes an array (`initWithActivityItems(items, null)`): its elements as the runtime marshals them.
		if (isUntyped(spelledType(source)) && /^\[[^:]*\]$/.test(b)) {
			const array = (value: string) => (b === '[Any]' ? `${RT.jsToNativeArray}(${value})` : typedCollection(`${RT.jsToNativeArray}(${value})`, b)!);
			return optional(target) ? `${RT.jsUnlessNullish}(${t.expr(e)}, { ${array('$0')} })` : array(t.expr(e));
		}
		// A possibly missing option set where Swift takes one: none of the options.
		if (!optional(target) && source.endsWith('?') && this.isOptionSet(b)) return `(${t.expr(e)} ?? [])`;
		// A possibly missing string where Swift takes one: Objective-C would receive nil, which reads as empty.
		if (b === 'String' && !optional(target) && source === 'String?') return `(${t.expr(e)} ?? "")`;
		// A string where Swift has a string-backed type (`UIMenu.Identifier`); a constant of that type as Swift declares it.
		const native = ts.isIdentifier(e) ? this.symbolModule(this.t.resolve(e)) : null;
		const constant = native && lookupConstant(native.module, native.name);
		if (constant && base(constant.type) === b) return constant.swift;
		// A Core Foundation constant (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, a CFString) where Swift takes any object: the constant itself.
		if (constant && /^(CFTypeRef|AnyObject)$/.test(b) && CF_CLASSES.has(base(constant.type))) return constant.swift;
		// A constant of a typed-constants struct (`CFRunLoopMode`) where Swift takes any object: its raw value.
		if (constant && /^(CFTypeRef|AnyObject|Any)$/.test(b) && this.isTypedConstants(base(constant.type))) return `(${constant.swift}.rawValue as CFTypeRef)`;
		// Null where Swift takes a collection it marks nonnull: Objective-C receives nil, which reads as empty.
		if (source.endsWith('?') && !optional(target) && b.startsWith('[') && source.slice(0, -1) === b) return `(${t.expr(e)} ?? ${b.includes(':') ? '[:]' : '[]'})`;
		const raw = source === 'Double' ? this.constantsRaw(b) : null;
		if (raw && NUMBERS.has(raw)) return `${b}(rawValue: ${integral(t.expr(e), raw)})`;
		// A string where Foundation takes a copyable key (`setObject(_:forKey:)`).
		if (/^String\??$/.test(source) && /^(any )?NSCopying$/.test(b)) return `(${t.expr(e)} as NSString)`;
		// A string or a number where a generic class takes any object (`NSCache<AnyObject, AnyObject>`): its Foundation object.
		if (/^(AnyObject|CFTypeRef)$/.test(b) && source === 'String') return `(${t.expr(e)} as NSString)`;
		if (b === 'AnyObject' && source === 'Double') return `NSNumber(value: ${t.expr(e)})`;
		// Null where Swift takes a collection it marks nonnull: Objective-C receives nil, which reads as empty.
		if (!optional(target) && source.endsWith('?') && ['NSDictionary', 'NSArray'].includes(b)) return `(${t.expr(e)} ?? ${b}())`;
		// A value the typings say may be null (`selectedViewController`) where Swift takes one: unwrapped, as the runtime would pass nil to a nonnull parameter.
		if (!optional(target) && optional(source) && base(source) === b && !['Any', 'Double', 'String', 'Bool'].includes(b)) return this.t.marks.unwrappedCode(t.expr(e));
		// An object that may be missing where Swift takes any value: passed as it is held, nil included, as the runtime passes it.
		if (b === 'Any' && !optional(target) && (optional(source) || t.lenientRef(source) !== source)) return `(${t.expr(e)} as Any)`;
		return t.expr(e);
	},

	/** A value's class for native bridging: `null` for a native constant, which keeps its own type. */
	bridgeClass(this: NativeAPI, e: ts.Expression, source: SwiftType): BridgeClass {
		const s = base(source);
		if (isUntyped(spelledType(source))) return 'untyped';
		if (s === 'Double') return 'number';
		if (s === 'String') return ts.isIdentifier(e) && this.symbolModule(this.t.resolve(e)) ? 'other' : 'string';
		if (/^(Object_\w+|JSObject|JSRecord<.*>)$/.test(s)) return 'scriptObject';
		if (s === 'NSMutableData') return 'mutableData';
		if (s === '[AnyHashable: Any]') return 'anyDictionary';
		if (this.isEnumType(s) && !this.isOptionSet(s) && NUMBERS.has(this.rawTypeOf(s))) return 'numericEnum';
		return 'other';
	},

	/**
	 * A C struct made from the object `o` names (Swift code), each field read by name as the runtime fills a struct from
	 * an object; null for a struct with a field that is neither a number nor such a struct.
	 */
	structFrom(this: NativeAPI, swift: string, o: string): string | null {
		if (!this.modules.size || !/^[A-Z]\w*$/.test(swift) || /^(Double|String|Bool|Void|Never)$|^JS/.test(swift)) return null;
		let fields: Record<string, string> | undefined;
		// CoreGraphics' geometry structs are declared in CoreFoundation's symbol graph.
		for (const m of new Set([...this.searchModules(), ...(this.modules.has('CoreGraphics') ? ['CoreFoundation'] : [])])) fields ??= Object.values(nativeTable(m).structs).find((x) => x.swift === swift)?.fields;
		if (!fields || !Object.keys(fields).length) return null;
		const parts: string[] = [];
		for (const [k, type] of Object.entries(fields)) {
			const field = `${RT.jsNativeStructField}(${o}, ${JSON.stringify(k)})`;
			const value = INTEGERS.has(type) ? `${RT.jsNativeInteger}(${field}, ${type}.self)` : type === 'Double' || type === 'TimeInterval' ? `${RT.jsNativeNumber}(${field})` : NUMBERS.has(type) ? `${type}(${RT.jsNativeNumber}(${field}))` : this.structFrom(type, `${RT.jsNativeStructMember}(${o}, ${JSON.stringify(k)})`);
			if (!value) return null;
			parts.push(`${k}: ${value}`);
		}
		return `${swift}(${parts.join(', ')})`;
	},

	/** A native slot's class for native bridging. */
	bridgeSlotClass(this: NativeAPI, b: SwiftType): BridgeClass {
		if (b === '[AnyHashable: Any]') return 'anyDictionary';
		if (b === 'NSDictionary') return 'nsDictionary';
		if (INTEGERS.has(b)) return 'integer';
		if (b === 'Double' || b === 'TimeInterval') return 'double';
		if (NUMBERS.has(b)) return 'floating';
		if (this.structFrom(b, '$0')) return 'cStruct';
		if (b === 'NSNumber') return 'numberObject';
		if (b === 'Data') return 'data';
		if (this.isStringConstants(b)) return 'stringConstant';
		const entry = /^\[([\w.]+): ([\w.]+)\]$/.exec(b);
		if (!entry) return 'other';
		if (entry[2] === 'Any' && entry[1] !== 'String' && entry[1] !== 'AnyHashable' && this.isStringConstants(entry[1])) return 'keyedDictionary';
		// Keys or values of a constant type are script's strings, which an entry's cast to that type would drop.
		return entry.slice(1).some((x) => this.constantsRaw(x) || this.isEnumType(x)) ? 'other' : 'typedDictionary';
	},

	/** `e` (Swift holds it as `source`) bridged where a native API takes `target`, by `nativeBridging`; null where no bridging step applies. */
	bridged(this: NativeAPI, e: ts.Expression, source: SwiftType, target: SwiftType): string | null {
		const b = base(target);
		const step = nativeBridging(this.bridgeClass(e, source), this.bridgeSlotClass(b));
		if (!step) return null;
		const code = this.t.expr(e),
			maybe = optional(source) && !isUntyped(spelledType(source));
		// Undefined and null stay nil where Swift takes an optional, as the runtime passes them; else the step's own empty value.
		const each = (spell: (x: string) => string) => (optional(target) && (maybe || isUntyped(spelledType(source))) ? `${RT.jsUnlessNullish}(${code}, { ${spell('$0')} })` : spell(code));
		switch (step) {
			case 'keyed': {
				const key = /^\[([\w.]+):/.exec(b)![1];
				return optional(target) ? `${RT.jsNativeKeyedOrNil}(${code}, ${key}.self)` : `${RT.jsNativeKeyed}(${code}, ${key}.self)`;
			}
			case 'dictionary': {
				const dictionary = optional(target) && maybe ? `${RT.jsUnlessNullish}(${code}, ${RT.jsToNativeDictionary})` : `${RT.jsToNativeDictionary}(${code})`;
				return b === 'NSDictionary' ? `(${dictionary} as NSDictionary${optional(target) && maybe ? '?' : ''})` : dictionary;
			}
			case 'integer':
			case 'floating':
			case 'double': {
				if (ts.isNumericLiteral(e)) return code;
				const n = isUntyped(spelledType(source)) ? `${RT.jsToNumber}(${code})` : maybe ? `(${code} ?? .nan)` : code;
				if (step === 'integer') return `${RT.jsNativeInteger}(${n}, ${b}.self)`;
				if (step === 'double') return `${RT.jsNativeNumber}(${n})`;
				// A native property of the same type, read as a number only to be passed back: the value itself, which is never undefined.
				const own = n === code && ts.isPropertyAccessExpression(e) && !e.questionDotToken && this.propertyType(e) === b ? /^Double\((.*)\)$/s.exec(code)?.[1] : undefined;
				return own && balanced(own) ? own : `${b}(${RT.jsNativeNumber}(${n}))`;
			}
			case 'struct':
				return ts.isObjectLiteralExpression(ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses)) ? code : `${RT.jsNativeStructOf}(${code}, { ${this.structFrom(b, '$0')} })`;
			case 'dictionaryEntries':
				return each((x) => typedCollection(`${RT.jsToNativeDictionary}(${x})`, b)!);
			case 'entries':
				return each((x) => typedCollection(x, b)!);
			case 'numberObject':
				return maybe ? this.t.marks.unwrappedIf(`${code}.map { NSNumber(value: $0) }`, !optional(target)) : `NSNumber(value: ${code})`;
			case 'enumNumberObject':
				return maybe ? this.t.marks.unwrappedIf(`${code}.map { NSNumber(value: $0.rawValue) }`, !optional(target)) : `NSNumber(value: ${code}.rawValue)`;
			case 'stringConstant':
				if (isUntyped(spelledType(source))) return optional(target) ? `${RT.jsNativeString}(${code}).map { ${b}(rawValue: $0) }` : `${b}(rawValue: ${RT.jsToString}(${code}))`;
				return maybe ? this.t.marks.unwrappedIf(`{ (__s: String?) -> ${b}? in __s.map { ${b}(rawValue: $0) } }(${code})`, !optional(target)) : `${b}(rawValue: ${code})`;
			case 'bridged':
				return optional(target) ? `(${code} as ${b}?)` : `(${code}${maybe ? '!' : ''} as ${b})`;
		}
	},

	/** A Swift API's value as TypeScript reads it: numbers are Double, an implicitly unwrapped or optional object is the object. */
	fromSwift(this: NativeAPI, code: string, swiftType: SwiftType, e: ts.Expression, as?: string): string {
		swiftType = this.numericAlias(swiftType);
		// A result nothing reads: a nil one is no error.
		if (this.keepOptional.has(e) || ts.isExpressionStatement(e.parent)) return code;
		// A value only tested (`if (controller.viewControllers)`): nil is falsy, not an error.
		if (optional(swiftType) && onlyTested(e)) return code;
		const tsType = as ?? this.t.typeOf(e);
		// Lenient code holds a missing one as the optional it is; where it is used, JavaScript's TypeError if that throws.
		if (!as && optional(swiftType) && !optional(tsType) && !['Double', 'String', 'Bool', 'Void'].includes(tsType) && this.t.lenient && this.t.loose(e)) {
			const held = this.fromSwift(code, swiftType, e, optionalType(tsType));
			return this.t.marks.rootImplicit(held) ? held : this.t.marks.implicitOf(held);
		}
		if (!as && optional(swiftType) && !optional(tsType) && !this.t.lenient && this.t.states.nilKept(e)) return this.fromSwift(code, swiftType, e, optionalType(tsType));
		const b = base(swiftType);
		const bridged = bridge(code, swiftType, tsType);
		if (bridged) return bridged;
		// A member the code has narrowed (`layer.mask instanceof CAShapeLayer`): the subclass it tested for.
		const declared = ts.isPropertyAccessExpression(e) ? this.t.checker.getSymbolAtLocation(e.name) : undefined;
		const narrowedTo = base(tsType);
		if (declared && /^[A-Z]\w*$/.test(narrowedTo) && narrowedTo !== b && /^[A-Z]\w*$/.test(b) && !this.isEnumType(narrowedTo) && !this.isStructType(narrowedTo) && base(this.t.type(this.t.checker.getTypeOfSymbol(declared), e)) === b) {
			// Lenient code holds the member optional, checked where it is needed present.
			if (!optional(tsType) && this.t.lenient && this.t.lenientRef(narrowedTo) !== narrowedTo && this.t.loose(e)) return this.t.marks.castCode(code, narrowedTo, 'as?', true);
			return `(${code} as${optional(tsType) ? '?' : '!'} ${narrowedTo})`;
		}
		if (b === 'Date' && base(tsType) === 'JSDate') return optional(swiftType) ? unwrapAs(this.t.marks, `${code}.map { JSDate($0) }`, tsType, this.t.lenient && this.t.lenientRef(tsType) !== tsType) : `JSDate(${code})`;
		if (NUMBERS.has(b) && isNamed(spelledType(tsType), 'Double', false)) {
			if (b === 'Double' || b === 'TimeInterval') return optional(swiftType) && !tsType.endsWith('?') ? `(${code} ?? .nan)` : code;
			return optional(swiftType) ? unwrapAs(this.t.marks, `${code}.map { Double($0) }`, tsType, this.t.lenient && this.t.lenientRef(tsType) !== tsType) : `Double(${code})`;
		}
		// The runtime gives script an NSNumber as the number it holds.
		if (b === 'NSNumber' && /^Double\??$/.test(tsType)) return optional(swiftType) ? `${code}${tsType.endsWith('?') ? '?' : '!'}.doubleValue` : `${code}.doubleValue`;
		if ((this.isEnumType(b) || this.isNumericConstants(b)) && tsType === 'Double') return optional(swiftType) ? `Double(${code}!.rawValue)` : `Double(${code}.rawValue)`;
		// A Core Foundation string (`kUTTypePlainText`), a string to TypeScript.
		if (b === 'CFString' && /^String\??$/.test(tsType)) return optional(swiftType) ? unwrapAs(this.t.marks, `(${code} as String?)`, tsType, this.t.lenient && this.t.lenientRef(tsType) !== tsType) : `(${code} as String)`;
		// A string-backed constant (`NSNotification.Name`), a string to TypeScript.
		// A number-backed constant (`UIFontWeightBold`), a number to TypeScript.
		if (tsType === 'Double' && NUMBERS.has(this.constantsRaw(b) ?? '')) return optional(swiftType) ? `Double(${code}!.rawValue)` : `Double(${code}.rawValue)`;
		// Lenient code tests a missing one (`textField.textContentType !== undefined`): held as script holds undefined.
		if (/^String\??$/.test(tsType) && this.isStringConstants(b)) return optional(swiftType) ? (tsType.endsWith('?') ? `${code}?.rawValue` : this.t.lenient ? this.t.marks.implicitOf(`${code}?.rawValue`) : `${code}!.rawValue`) : `${code}.rawValue`;
		// A Foundation collection (`NSDictionary(dictionary:)`) where TypeScript reads the bridged Swift collection.
		if (/^NS(Mutable)?(Dictionary|Array|Set)$/.test(b) && tsType.startsWith('[')) {
			const to = tsType.replace(/\?$/, '');
			if (optional(swiftType)) return this.t.marks.castCode(code, to, 'as?');
			return typedCollection(code, to) ?? this.t.marks.castCode(code, to, 'as!');
		}
		if (b.startsWith('[') && isKit(spelledType(tsType), 'JSArray')) return `JSArray(${code}${optional(swiftType) ? ' ?? []' : ''})`;
		// Lenient code: a native object that may be nil is held as script holds null, unwrapped only where used.
		if (swiftType.endsWith('?') && !tsType.endsWith('?') && !isUntyped(spelledType(tsType))) return this.absentAs(code, tsType);
		return code;
	},

	/** A TypeScript closure passed as an Objective-C block: Swift parameter types in, TypeScript's inside. */
	block(this: NativeAPI, fn: ts.ArrowFunction | ts.FunctionExpression, target: SwiftType): string {
		const t = this.t;
		const fnType = blockType(this.unalias(target));
		if (!fnType) return t.expr(fn);
		const sig = [fnType.text, fnType.params.join(', '), fnType.result];
		const params = fnType.params;
		const names = fn.parameters.map((p, k) => (ts.isIdentifier(p.name) ? p.name.text : `__p${k}`));
		// A block's own block parameters (`completion` of a deferred menu's provider) escape: Objective-C marks none noescape here.
		const swiftParams = params.map((p, k) => `__b${k}: ${/->/.test(p) && !/[?!]$/.test(p.trim()) && !p.startsWith('@escaping') ? `@escaping ${p}` : p}`);
		const binds = params
			.map((p, k) => {
				if (!names[k]) return '';
				const param = fn.parameters[k],
					type = t.typeOf(param.name);
				// A nil object argument reaches a closure that takes it implicitly unwrapped (core's `(image) => { if (image) … }`).
				if (optional(p) && base(p) === type && t.states.mayBeNull(param)) return `let ${names[k]}: ${type}? = __b${k}`;
				// Bridged or a subclass (`data: NSData` for `Data?`, `response: NSHTTPURLResponse` for `URLResponse?`): converted as an optional, nil kept.
				if (optional(p) && t.states.mayBeNull(param)) return `let ${names[k]}: ${type}? = ${this.blockParam(`__b${k}`, p, `${type}?`)}`;
				return `let ${names[k]}: ${type} = ${this.blockParam(`__b${k}`, p, type)}`;
			})
			.filter(Boolean);
		const body = t.closure(fn);
		const throws = t.throwsInfo.fn(fn);
		const call = `(${body})(${names.map((n) => n).join(', ')})`;
		const ret = sig[2].trim();
		const inner = ret === 'Void' ? (throws ? `${RT.jsReport} { try ${call} }` : `${call}`) : throws ? `${RT.jsReportedOrZero} { try ${call} }` : call;
		const run = `${binds.join('; ')}${binds.length ? '; ' : ''}${ret === 'Void' ? inner : `return ${inner}`}`;
		return `${posted(ret, params) ? RT.jsEnter : RT.jsEnterAwaiting} { (${swiftParams.join(', ')}) -> ${ret} in ${run} }`;
	},

	/** A function value (Swift's are `throws`) where Swift takes a block returning nothing: called through one, what it throws reported. */
	heldBlock(this: NativeAPI, code: string, source: string, target: SwiftType): string | null {
		const unwrapped = /^\(.*\)[?!]$/.test(source) && blockType(source.slice(1, -2)) ? source.slice(1, -2) : source;
		const fn = /\bthrows\b/.test(unwrapped) ? blockType(unwrapped) : null;
		const want = blockType(this.unalias(target));
		if (!fn || !want || want.result !== 'Void' || fn.params.length > want.params.length) return null;
		const args = fn.params.map((p, k) => this.blockParam(`__b${k}`, want.params[k], p.replace(/^@escaping /, '')));
		const report = `${RT.jsReport} { try __f(${args.join(', ')}) }`;
		// Sendable, as the SDK may declare the block (its table's types leave that out): it enters script on the main thread.
		const block = /^@Sendable\b/.test(want.text) ? want.text : `@Sendable ${want.text}`;
		const wrap = `{ (__f: @escaping ${unwrapped}) -> ${block} in ${posted('Void', want.params) ? RT.jsEnter : RT.jsEnterAwaiting} { (${want.params.map((p, k) => `__b${k}: ${p}`).join(', ')}) in ${report} } }`;
		// An optional block parameter takes the function through an optional: lenient code holds a missing one (`fn || null`) as nil though its type says present.
		if (unwrapped === source) return optional(target) ? `{ (__o: (${unwrapped})?) -> (${block})? in __o.map(${wrap}) }(${code})` : `${wrap}(${code})`;
		return this.t.marks.unwrappedIf(`(${code}).map(${wrap})`, !optional(target));
	},

	/** Whether a native class extends another (`AVURLAsset` of `AVAsset`). */
	isSubclass(this: NativeAPI, sub: string, base: string): boolean {
		const modules = new Set(['Foundation', 'UIKit', ...this.modules]);
		// By JavaScript name: a Foundation class Swift names without its prefix (`HTTPURLResponse`) is found under it.
		const js = (m: string, n: string) => (lookupClass(m, n) ? n : lookupClass(m, `NS${n}`)?.swift === n ? `NS${n}` : null);
		const b = [...modules].map((m) => js(m, base)).find(Boolean) ?? base;
		for (const m of modules) {
			const s = js(m, sub);
			if (s && lookupClass(m, s)?.kind === 'class') return conformsTo(m, s, b);
		}
		return false;
	},

	blockParam(this: NativeAPI, code: string, swiftType: SwiftType, tsType: string): string {
		const b = base(swiftType);
		if (NUMBERS.has(b) && tsType === 'Double') return b === 'Double' ? code : `Double(${code})`;
		// A block handed to the block (`completion([UIMenuElement])`) where TypeScript types it otherwise (`(items: any[]) => void`): called with its arguments converted.
		const plain = swiftType.replace(/^@escaping\s+/, '').trim();
		if (functionParts(plain) && functionParts(tsType) && plain !== tsType) return this.t.convert(code, plain, tsType);
		// A Foundation value type the TypeScript declarations name by its class (`Notification` as `NSNotification`).
		const bridged = bridge(code, swiftType, tsType);
		if (bridged) return bridged;
		if (b === 'Date' && base(tsType) === 'JSDate') return optional(swiftType) ? unwrapAs(this.t.marks, `${code}.map { JSDate($0) }`, tsType, this.t.lenient && this.t.lenientRef(tsType) !== tsType) : `JSDate(${code})`;
		// A block parameter the handler declares as a subclass (`(urlAsset: AVURLAsset)` for an `AVAsset`): the object as it.
		const tb = tsType.replace(/[?!]$/, '');
		if (b !== tb && /^[A-Z]\w*$/.test(b) && /^[A-Z]\w*$/.test(tb) && this.isSubclass(tb, b)) {
			if (tsType.endsWith('?')) return this.t.marks.castCode(code, tb, 'as?');
			// Lenient code holds the parameter optional.
			return this.t.lenient && this.t.lenientRef(tb) !== tb ? this.t.marks.castCode(code, tb, 'as?', true) : this.t.marks.castCode(code, tb, 'as!');
		}
		if (optional(swiftType) && !tsType.endsWith('?') && !isUntyped(spelledType(tsType))) return this.absentAs(code, tsType);
		return code;
	},

	/**
	 * A native optional TypeScript declares present (`stringForKey` returns `string`): nil as the value
	 * script then holds converts where a string, number or boolean is used (core tests `if (!uuid)`);
	 * an object stays missing until a member is read (lenient code), or unwraps.
	 */
	absentAs(this: NativeAPI, code: string, tsType: string): string {
		if (tsType === 'String') return `(${code} ?? "")`;
		if (tsType === 'Bool') return `(${code} ?? false)`;
		if (tsType === 'Double') return `(${code} ?? .nan)`;
		return this.t.lenient && this.t.lenientRef(tsType) !== tsType ? this.t.marks.implicitOf(code) : this.t.marks.unwrappedCode(code);
	},
};
