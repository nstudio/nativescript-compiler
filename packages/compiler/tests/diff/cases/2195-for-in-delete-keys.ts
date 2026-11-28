// Deleting own keys while iterating a plain object (for..in / Object.keys) does not throw ConcurrentModificationException.
const map: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
const removed: string[] = [];
for (const key in map) {
	if (map[key] % 2 === 0) {
		removed.push(key);
		delete map[key];
	}
}
console.log('for-in', removed.join(','), Object.keys(map).join(','));

const all: Record<string, string> = { x: '1', y: '2', z: '3' };
const visited: string[] = [];
for (const key in all) {
	visited.push(`${key}=${all[key]}`);
	delete all[key];
}
console.log('clear', visited.join(','), Object.keys(all).length);

const keyed: Record<string, number> = { p: 10, q: 20, r: 30 };
const seen: string[] = [];
for (const k of Object.keys(keyed)) {
	seen.push(k);
	delete keyed[k];
}
console.log('keys', seen.join(','), Object.keys(keyed).length);
