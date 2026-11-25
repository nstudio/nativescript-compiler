// A class whose toString gives no string: converting its instance finds no primitive and throws ToPrimitive's TypeError,
// while calling the method itself gives its object.
class Odd {
	toString(): object { return { odd: true }; }
}
const o = new Odd();
try { console.log(`${o}`); } catch (e) { console.log('template', (e as Error).constructor.name); }
try { console.log('a' + o); } catch (e) { console.log('concat', (e as Error).constructor.name); }
try { console.log(String(o)); } catch (e) { console.log('String', (e as Error).constructor.name); }
console.log(typeof o.toString(), JSON.stringify(o.toString()));
class Counted {
	constructor(public n: number) {}
	valueOf(): number { return this.n; }
	toString(): object { return {}; }
}
const c = new Counted(4);
console.log(+c, c.valueOf() * 2, `${c.n}`);
try { console.log(`${c}`); } catch (e) { console.log('counted', (e as Error).constructor.name); }
