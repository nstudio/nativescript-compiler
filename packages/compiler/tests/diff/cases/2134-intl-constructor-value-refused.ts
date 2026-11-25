// @refused Intl.DateTimeFormat is not supported in a release build yet
// An Intl constructor read as a value: compiled only as the callee of `new` or a call.
if (typeof Intl === 'object' && Intl.DateTimeFormat) {
  console.log(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new Date(0)));
}
