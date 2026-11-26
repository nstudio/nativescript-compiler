// @app-lenient
// A function declaration reading `this` and its `arguments` both takes `__this` beside `__arguments`.
const seen = [];
function record() {
  seen.push([this, arguments.length]);
}
record.call({ id: 1 }, 'a', 'b');
record();
console.log(seen.length, seen[0][0].id, seen[0][1], seen[1][0], seen[1][1]);
