// @refused Intl.Collator is not supported in a release build yet
// An Intl service the runtimes do not have: only Intl.NumberFormat and Intl.DateTimeFormat are compiled.
const collator = new Intl.Collator('en');
console.log(['b', 'a', 'C'].sort(collator.compare).join(','));
