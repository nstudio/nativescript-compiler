// @lenient-both
// Library mode: methods with erased type parameters (like Observable.notify<T>) stay reachable by name in jsGet / jsHasMember.
interface Ev {
	name: string;
	target?: Bus;
}

class Bus {
	seen: string[] = [];

	notify<T extends Ev>(data: T): void {
		data.target = data.target || this;
		this.seen.push(`${data.name}:${data.target === this}`);
	}

	find<T>(id: string): T {
		return (`found:${id}` as unknown) as T;
	}
}

class SubBus extends Bus {
	batch<T>(cb: () => T): T {
		return cb();
	}
}

const bus = new Bus();
const anyBus: any = bus;
console.log('has', typeof anyBus.notify, typeof anyBus.find);
const bound = anyBus.notify.bind(bus);
bound({ name: 'bound' });
anyBus.notify({ name: 'direct' });
console.log('bus', bus.seen.join(','), anyBus.find('a'));

const sub = new SubBus();
const anySub: any = sub;
console.log('subHas', typeof anySub.notify, typeof anySub.batch);
anySub.notify.call(sub, { name: 'sub' });
console.log('sub', sub.seen.join(','), anySub.batch(() => 'ok'));
