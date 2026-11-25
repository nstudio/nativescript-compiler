// An app's own types named as core's AnimationPromise and AnimationDefinition are the app's.
interface AnimationPromise {
	done: boolean;
}
interface AnimationDefinition {
	duration: number;
}
const a: AnimationPromise = { done: true };
const d: AnimationDefinition = { duration: 300 };
function finish(p: AnimationPromise, def: AnimationDefinition): string {
	return `${p.done} after ${def.duration}ms`;
}
console.log(a.done, d.duration, finish(a, d));
