// A typed object's declared field is an own property like any other: delete removes it, and
// Object.defineProperty(…, { writable: false }) makes later writes throw in strict code.
class K { a = 1; b?: number = 2; }
const k = new K();
const uk: any = k;
console.log(delete uk.b, 'b' in k, k.b, Object.keys(k).join(','));
const lit: { x: number; y?: number } = { x: 1, y: 2 };
const ul: any = lit;
console.log(delete ul.y, 'y' in lit, lit.y, Object.keys(lit).join(','), JSON.stringify(lit));
const o: { k: number } = { k: 1 };
try { Object.defineProperty(o, 'k', { value: 2, writable: false }); } catch (e) { console.log('define', (e as Error).constructor.name, (e as Error).message); }
console.log(o.k);
try { o.k = 3; console.log('no throw', o.k); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
const u: any = o;
try { u.k = 4; console.log('no throw', u.k); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
console.log(o.k, JSON.stringify(Object.getOwnPropertyDescriptor(o, 'k')));
