import { fakeNow } from 'fake-framework';

export function later(seconds: number): number {
  return fakeNow() + seconds;
}
