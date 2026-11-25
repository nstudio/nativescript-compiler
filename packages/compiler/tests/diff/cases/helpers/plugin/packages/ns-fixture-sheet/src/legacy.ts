export const entry = 'main';
export function count(from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k++) out.push(k * k);
  return out;
}
