// @refused Intl.NumberFormat.prototype.formatToParts is not supported in a release build yet
// A member Intl.NumberFormat has that the runtimes' formatter does not: format and resolvedOptions are compiled.
const nf = new Intl.NumberFormat('en-US');
console.log(nf.format(1234.5));
console.log(nf.formatToParts(1234.5).map((p) => p.type).join(','));
