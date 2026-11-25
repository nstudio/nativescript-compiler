// A string literal holding a lone surrogate, which a Swift string cannot: refused at build time.
// @refused-swift a string with a lone surrogate is a declared limit of release builds
const half = '\uD83D';
console.log(half.length, JSON.stringify(half));
