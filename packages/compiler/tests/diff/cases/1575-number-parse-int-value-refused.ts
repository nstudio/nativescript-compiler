// Number.parseInt read as a value, to compare it with the global parseInt.
// @refused Number.parseInt is not supported in a release build yet
console.log('Number.parseInt === parseInt', Number.parseInt === parseInt, Number.parseInt('42px'));
