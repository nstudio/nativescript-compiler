// A Symbol held untyped: `String(sym)` gives its description, and comparing it is a TypeError.
const sym: any = Symbol('s');
const num: any = 3;
console.log(String(sym), String(Symbol('t')));
try { console.log(sym < num); } catch (e) { console.log('sym', (e as Error).constructor.name, (e as Error).message); }
try { console.log(num >= sym); } catch (e) { console.log('sym right', (e as Error).constructor.name); }
