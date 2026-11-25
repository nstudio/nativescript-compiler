import { Observable } from '@nativescript/core';

export class KitModel extends Observable {
  private _count = 0;
  letters = ['a', 'b', 'c'];
  rows = ['one', 'two', 'three'];

  get count(): number {
    return this._count;
  }

  set count(value: number) {
    if (this._count !== value) {
      this._count = value;
      this.notifyPropertyChange('count', value);
    }
  }

  onTap() {
    this.count = this.count + 1;
  }
}
