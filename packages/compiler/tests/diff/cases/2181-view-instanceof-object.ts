// instanceof Object through a structural interface view: unwraps the underlying root and rejects primitives.
interface HasA {
	a: number;
}

function checkObj(x: HasA): boolean {
	return x instanceof Object;
}

const nullProto = Object.create(null);
nullProto.a = 1;

const chainNullProto = Object.create(Object.create(null));
chainNullProto.a = 2;

const plain: HasA = { a: 3 };
const dynamicPlain: any = { a: 4 };

console.log('nullProto-direct:', nullProto instanceof Object);
console.log('nullProto-view:', checkObj(nullProto));
console.log('chain-view:', checkObj(chainNullProto));
console.log('plain-direct:', checkObj(plain));
console.log('plain-view:', checkObj(dynamicPlain));
console.log('num-view:', checkObj(42 as any));
console.log('str-view:', checkObj('hi' as any));
console.log('bool-view:', checkObj(true as any));
console.log('bigint-view:', checkObj(1n as any));
console.log('null-view:', checkObj(null as any));
console.log('undef-view:', checkObj(undefined as any));
