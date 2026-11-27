import type { Ledger } from './ledger.ts';

/** The typings of the platform a build does not bind (`Ledger.nativeSdk`): what they declare only the other platform's code holds. */
export function otherPlatformTypings(ledger: Pick<Ledger, 'nativeSdk'>): RegExp {
	return ledger.nativeSdk === 'apple' ? /[\\/]@nativescript[\\/]types-android[\\/]/ : /[\\/]@nativescript[\\/]types-ios[\\/]/;
}
