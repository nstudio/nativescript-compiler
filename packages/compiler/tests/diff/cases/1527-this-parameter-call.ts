// A function declaring a `this` parameter, called through call, apply and bind, with an object and with undefined.
function named(this: { n: number } | undefined, a: number) {
  return (this?.n ?? -1) + a;
}
console.log('typed call/apply/bind', named.call({ n: 1 }, 2), named.apply({ n: 2 }, [3]), named.bind({ n: 3 })(4), named.call(undefined, 5));
