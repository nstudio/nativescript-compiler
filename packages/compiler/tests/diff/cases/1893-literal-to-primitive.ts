// An object literal's ToPrimitive tries valueOf then toString (number, default) or toString then valueOf (string),
// skipping a method that gives an object; a TypeError where neither gives a primitive.
const a: any = { valueOf() { return {}; }, toString() { return '7'; } };
console.log(+a, `${a}`, a + 1, String(a), a < 8);
const b: any = { toString() { return {}; }, valueOf() { return 5; } };
console.log(+b, `${b}`, String(b), b + 1, b > 4);
const ta = { valueOf(): any { return {}; }, toString() { return '8'; } };
console.log(+ta, `${ta}`, String(ta), ta + '');
const tb = { toString(): any { return {}; }, valueOf() { return 6; } };
console.log(+tb, `${tb}`, String(tb), tb + '');
const only = { toString(): any { return {}; } };
try { console.log(+only); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
const c: any = { valueOf() { return {}; }, toString() { return {}; } };
try { console.log(+c); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
try { console.log(`${c}`); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
try { console.log(c + ''); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
