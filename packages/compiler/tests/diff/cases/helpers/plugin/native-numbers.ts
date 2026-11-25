// A plugin compiled from its source, written as plugins that drive native APIs are: no strictNullChecks, optional
// parameters and options' fields passed on where the API takes an integer or a float.
export interface QueueOptions {
  limit?: number;
}

export function limit(q: NSOperationQueue, options: QueueOptions): number {
  q.maxConcurrentOperationCount = options.limit;
  return q.maxConcurrentOperationCount;
}

export function untypedLimit(q: NSOperationQueue, entry: any): number {
  q.maxConcurrentOperationCount = entry.limit;
  return q.maxConcurrentOperationCount;
}

export function float(f?: number): number {
  return NSNumber.numberWithFloat(f) as any;
}

export function unsigned(n?: number): number {
  return NSNumber.numberWithUnsignedInt(n) as any;
}

export function wide(options: { n?: number }): number {
  return NSNumber.numberWithLongLong(options.n) as any;
}
