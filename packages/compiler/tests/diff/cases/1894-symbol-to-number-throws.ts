// ToNumber of a Symbol is a TypeError, whether by unary plus, Number(), or arithmetic; console's %d prints NaN.
const s: any = Symbol('k');
try { console.log(+s); } catch (e) { console.log('plus', (e as Error).constructor.name, (e as Error).message); }
try { console.log(Number(s)); } catch (e) { console.log('Number', (e as Error).constructor.name, (e as Error).message); }
try { console.log(s * 2); } catch (e) { console.log('times', (e as Error).constructor.name, (e as Error).message); }
try { console.log(s < 1); } catch (e) { console.log('less', (e as Error).constructor.name, (e as Error).message); }
const t = Symbol('t');
try { console.log(Number(t)); } catch (e) { console.log('typed Number', (e as Error).constructor.name, (e as Error).message); }
console.log('%d', s);
console.log(s == 1, s == s);
