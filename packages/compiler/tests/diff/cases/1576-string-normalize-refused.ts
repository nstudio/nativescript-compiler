// String.prototype.normalize, comparing a precomposed character with its decomposed form.
// @refused String.normalize is not supported in a release build yet
console.log('"\u00e9".normalize("NFD") === "e\u0301"', '\u00e9'.normalize('NFD') === 'e\u0301');
