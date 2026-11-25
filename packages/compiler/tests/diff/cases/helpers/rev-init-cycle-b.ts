import { getNums, getCount, getMut, setMut } from './rev-init-cycle-a.ts';

function capture(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (e: any) {
    return e?.name ?? String(e);
  }
}

export const early = [capture(getNums), capture(getCount), capture(getMut), capture(() => setMut(1))];
