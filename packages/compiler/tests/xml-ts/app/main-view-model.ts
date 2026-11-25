import { Observable } from '@nativescript/core';

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
    if (this._message !== value) {
      this._message = value;
      this.notifyPropertyChange('message', value);
    }
  }

  onTap() {
    this.counter++;
    this.message = `Tapped ${this.counter} times`;
  }
}
