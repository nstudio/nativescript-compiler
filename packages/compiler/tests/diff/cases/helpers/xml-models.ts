// The models of the XML binding-context cases: an Observable as core's sets and reads keys by name, and app classes.
export class Observable {
  set(name: string, value: any): void {
    if ((this as any)[name] !== value) (this as any)[name] = value;
  }
  get(name: string): any {
    return (this as any)[name];
  }
  notifyPropertyChange(name: string, value: any): void {}
}

export class HelloWorldModel extends Observable {
  private _counter = 0;
  private _message = 'Hello from XML';
  items = ['one', 'two', 'three'];
  get counter(): number {
    return this._counter;
  }
  set counter(value: number) {
    if (this._counter !== value) {
      this._counter = value;
      this.notifyPropertyChange('counter', value);
    }
  }
  get message(): string {
    return this._message;
  }
  set message(value: string) {
    this._message = value;
  }
  onTap() {
    this.counter++;
    this.message = `Tapped ${this.counter} times`;
  }
}

export class Fruit {
  constructor(public name: string, public count: number) {}
}
