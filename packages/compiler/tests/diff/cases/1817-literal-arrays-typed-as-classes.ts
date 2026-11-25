// @lenient-both
// Library mode: an array of object literals given where an array of one of the program's classes is taken is made of
// the class's objects.
class Keyframe {
	offset = 0;
	value = '';
}
function frames(values: string[]): Keyframe[] {
	return values.map((v, k) => ({ offset: k / values.length, value: v }));
}
console.log(frames(['a', 'b']).map((f) => f.offset + ':' + f.value).join(' '));
