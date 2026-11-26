// Intl.Collator: sorting, sensitivity, numeric comparison, and resolvedOptions.
const collator = new Intl.Collator('en');
console.log(['b', 'a', 'C'].sort(collator.compare).join(','));
const num = new Intl.Collator('en', { numeric: true });
console.log(['item10', 'item2', 'item1'].sort(num.compare).join(','));
const base = new Intl.Collator('en', { sensitivity: 'base' });
console.log(base.compare('a', 'A'), base.compare('a', 'á'), base.compare('a', 'b') < 0);
const opts = num.resolvedOptions();
console.log(opts.usage, opts.sensitivity, opts.numeric, opts.ignorePunctuation, opts.caseFirst);
