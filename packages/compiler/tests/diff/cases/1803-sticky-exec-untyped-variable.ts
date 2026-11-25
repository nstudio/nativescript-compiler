// @app-lenient
// @cli-program
// A non-strict app's untyped variable given exec's match: its members read as the match's, a TypeError where it is null.
var r = /./y;
var match;
r.lastIndex = 1;
match = r.exec('abc');
console.log(match !== null, match.length, match[0], match.index);
r.lastIndex = 5;
match = r.exec('abc');
try {
	console.log(match.length);
} catch (e) {
	console.log('TypeError', e instanceof TypeError);
}
