// A Symbol held untyped, converted by an operator: a TypeError as a number or a string, where String() gives its description.
function attempt(name: string, run: () => unknown) {
  try {
    console.log(name, run());
  } catch (e) {
    console.log(name, (e as Error).constructor.name, (e as Error).message);
  }
}
const sym: any = Symbol('s');
attempt('sym + 1', () => sym + 1);
attempt('sym + "x"', () => sym + 'x');
attempt('"x" + sym', () => 'x' + sym);
attempt('`${sym}`', () => `${sym}`);
attempt('String(sym)', () => String(sym));
attempt('-sym', () => -sym);
