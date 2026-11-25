// A typed object literal whose toString may give no primitive: ToPrimitive's TypeError reaches the `catch`, and a
// function converting it throws to its caller.
const only = { toString(): any { return {}; } };
try { console.log(+only); } catch (e) { console.log('unary', (e as Error).constructor.name, (e as Error).message); }
try { console.log(`${only}`); } catch (e) { console.log('template', (e as Error).constructor.name, (e as Error).message); }
try { console.log('a' + only); } catch (e) { console.log('concat', (e as Error).constructor.name, (e as Error).message); }
function describe(o: { toString(): any }): string {
	return `<${o}>`;
}
try { console.log(describe(only)); } catch (e) { console.log('describe', (e as Error).constructor.name, (e as Error).message); }
console.log(describe({ toString() { return 'fine'; } }));
