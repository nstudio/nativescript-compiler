// @xml-keys counter message onTap title
// An XML app with no run-time XML site: a model held untyped only by a `bindingContext`, and a view only by generated
// code, are read by name only by the keys the XML and the app's code name. Their fields stay their own keys, so
// printing, JSON and Object.keys show the private ones as JavaScript does.
import { readKey, setAttribute, writeKey } from './helpers/xml-keys.ts';

class Observable {
  private _observers: Record<string, number> = {};
  set(name: string, value: any): void {
    writeKey(this, name, value);
    this._observers[name] = (this._observers[name] ?? 0) + 1;
  }
  get(name: string): any {
    return readKey(this, name);
  }
}

class View extends Observable {
  bindingContext: any = undefined;
}

class HelloWorldModel extends Observable {
  private _counter = 0;
  private _message = 'Hello from XML';
  items = ['one', 'two', 'three'];

  get counter(): number {
    return this._counter;
  }
  set counter(value: number) {
    this._counter = value;
  }
  get message(): string {
    return this._message;
  }
  set message(value: string) {
    this._message = value;
  }
  onTap(): void {
    this.counter++;
    this.message = `Tapped ${this.counter} times`;
  }
  describe(): string {
    return this._message + ' / ' + this._counter;
  }
}

class Card extends View {
  private label = 'untitled';
  get title(): string {
    return this.label;
  }
  set title(value: string) {
    this.label = value;
  }
  height(): number {
    return this.label.length;
  }
}

const page = new View();
page.bindingContext = new HelloWorldModel();
const model = page.bindingContext as HelloWorldModel;
console.log(model.get('counter'), model.get('message'), typeof readKey(model, 'onTap'));
model.onTap();
model.set('message', 'From the code-behind');
model.set('counter', 4);
console.log(model.counter, model.message, model.get('counter'));
console.log(model);
console.log(JSON.stringify(model));
console.log(Object.keys(model).join(','));
console.log(model.describe());

const card = new Card();
setAttribute(card, 'title', 'A code component');
console.log(card.title, readKey(card, 'title'), card.height());
console.log(JSON.stringify(card));
console.log(Object.keys(card).join(','));
