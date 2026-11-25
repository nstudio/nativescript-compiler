// Doc comments on class members, statics and nested functions, kept as KDoc and DocC.
class Meter {
  /**
   * The reading, in volts.
   * Never negative.
   */
  value = 0;

  /**
   * Adds to the reading.
   * A negative amount is ignored.
   */
  add(amount: number): void {
    if (amount > 0) this.value += amount;
  }

  /** The meter's zero. */
  static zero(): Meter {
    return new Meter();
  }
}

function outer(): number {
  /**
   * A nested helper.
   * Doubles its input.
   */
  function twice(n: number): number {
    return n * 2;
  }
  return twice(21);
}

const m = Meter.zero();
m.add(3);
m.add(-1);
console.log(m.value, outer());
