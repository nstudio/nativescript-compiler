// parseInt passed to map as a value held untyped: map's index becomes its radix.
console.log('[1, 2, 3].map(parseInt)', ['1', '2', '3'].map(parseInt as any));
