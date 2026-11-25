// A function's `name` and `length` are read-only: assignment throws a TypeError in strict (module) code, and other
// keys are the function's own properties.
function f(a: number, b: number) { return a + b; }
const g: any = f;
const report = (e: unknown) => console.log((e as Error).constructor.name, (e as Error).message.split(' of function')[0]);
try { g.name = 'x'; console.log('assigned', g.name); } catch (e) { report(e); }
try { g.length = 9; console.log('assigned', g.length); } catch (e) { report(e); }
console.log(g.name, g.length);
const arrow: any = (x: number) => x;
try { arrow.length = 3; console.log('assigned', arrow.length); } catch (e) { report(e); }
console.log(arrow.length);
const key = 'name';
try { g[key] = 'y'; console.log('assigned', g.name); } catch (e) { report(e); }
g.other = 1;
console.log(g.other, g.name);
