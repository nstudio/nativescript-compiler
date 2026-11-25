// @swift ledger:nativeSdk
// Objects made by script where CoreGraphics takes a size or a rectangle (a struct of structs): filled from the objects' fields.
function sized(w: number, h: number) {
  return { width: w, height: h };
}
function same(w: number, h: number, w2: number, h2: number): boolean {
  const a = sized(w, h);
  const b = { width: w2, height: h2 };
  return CGSizeEqualToSize(a, b);
}
function maxX(x: number, width: number): number {
  const rect = { origin: { x, y: 0 }, size: { width, height: 1 } };
  return CGRectGetMaxX(rect);
}
console.log(same(2, 3, 2, 3), same(2, 3, 2, 4), same(1.5, 1, 1.5, 1), maxX(1.5, 2), maxX(-4, 10));
