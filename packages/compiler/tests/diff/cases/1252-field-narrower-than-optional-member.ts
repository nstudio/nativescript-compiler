// A class field narrower than the optional interface member it implements: written undefined through the interface,
// it reads undefined through the class too, as in JavaScript.
interface Titled {
  title?: string;
  count?: number;
}
class Card implements Titled {
  title = 'x';
  count: number = 2;
  describe(): string {
    return `${this.title}/${this.count}`;
  }
}
const c = new Card();
const t: Titled = c;
console.log(c.title, t.title, c.describe());
t.title = undefined;
t.count = undefined;
console.log(c.title, t.title, c.title === undefined, c.describe(), JSON.stringify(c));
t.title = 'y';
console.log(c.title.length, t.title, c.describe());
