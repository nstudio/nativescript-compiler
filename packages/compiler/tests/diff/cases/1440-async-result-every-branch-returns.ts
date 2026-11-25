// @app-lenient
// A non-strict app's async functions whose every path returns (an if/else after an await, a try whose block and catch
// both return): nothing runs past the last statement, and each call resolves with the value its branch returns.
class Store {
  items: number[] = [];
}

class Service {
  store = new Store();

  async load(): Promise<number> {
    await Promise.resolve(0);
    this.store.items.push(1);
    return this.store.items.length;
  }

  async update(fail: boolean): Promise<boolean> {
    try {
      const r: any = await Promise.resolve(JSON.parse(fail ? 'null' : '{"body":1}'));
      if (r.body) {
        return true;
      } else {
        return false;
      }
    } catch (err) {
      return false;
    }
  }

  async validate(reload = false): Promise<boolean> {
    if (this.store.items.length) {
      if (reload) {
        await this.load();
      }
      if (!this.store.items[1]) {
        return false;
      } else {
        return true;
      }
    } else {
      return false;
    }
  }
}

async function main() {
  const s = new Service();
  console.log(await s.update(false), await s.update(true), await s.validate());
  console.log(await s.load(), await s.validate(), await s.validate(true));
}
main();
