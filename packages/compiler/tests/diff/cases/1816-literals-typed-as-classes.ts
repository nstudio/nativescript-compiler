// @lenient-both
// Library mode: an object literal typed as one of the program's classes is made as the class's object.
class Keyframe {
	offset = 0;
	value = '';
}
const first: Keyframe = { offset: 0.5, value: 'half' };
const frames: Keyframe[] = [first, { offset: 1, value: 'end' }];
console.log(first.offset, first.value, JSON.stringify(first), frames.map((f) => f.value).join(','), JSON.stringify(frames));
