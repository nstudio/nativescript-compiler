// What a measurement tool watches of a translation (tests/shadow/, loaded with `node --import tests/shadow/install.ts`):
// unset in a build. A hook only observes: it is given what the translator computed anyway, and its answers are ignored.
import type ts from 'typescript';
import type { Held } from './conversion.ts';
import type { PlacementBackend } from './placement.ts';
import type { ValueStates } from './states/value-states.ts';

/** A second container built for a value the code already holds. */
export type KeepKind = 'elements' | 'upcast' | 'widen' | 'record-widen' | 'untyped-read' | 'promise';

export const observers: {
	/** A translator started, with the value states it asks. */
	translator?(translator: object, states: ValueStates): void;
	/** Value states made for a translator. */
	states?(states: ValueStates): void;
	/** A container built for a value already held (an elementwise copy, an upcast or widening rebuild, a checked read). */
	keep?(backend: 'swift' | 'kotlin', kind: KeepKind, from: string, to: string, file: string | null | undefined, library: boolean, line?: number): void;
	/** The carrier a placement read for `e`, before it places it into `target`. */
	held?(b: PlacementBackend, e: ts.Expression, held: Held, target: string): void;
} = {};
