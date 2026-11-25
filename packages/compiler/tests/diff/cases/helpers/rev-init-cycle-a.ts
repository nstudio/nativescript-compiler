import { early } from './rev-init-cycle-b.ts';

const raw: any = [10, 20, 30];
const rawNum: any = 42;
export const nums: number[] = raw;
export const count: number = rawNum;
export let mut: number = rawNum;

export function getNums(): number {
	return nums.length;
}
export function getCount(): number {
	return count;
}
export function getMut(): number {
	return mut;
}
export function setMut(v: number): void {
	mut = v;
}

export function runCycle(): string[] {
	const out = ['early: ' + early.join(',')];
	setMut(99);
	out.push('after: ' + getNums() + ' ' + getCount() + ' ' + getMut());
	return out;
}
