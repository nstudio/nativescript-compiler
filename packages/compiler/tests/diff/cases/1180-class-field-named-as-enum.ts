// A class's fields named as the enum or object they hold (a component handing an enum to its template), and the class's
// own code reading the enum or object by that name.
enum Status { Open = 'open', Done = 'done' }
const Axis = { Linear: 1, Log: 2 } as const;
enum Level { Low, High }

class Card {
  Status = Status;
  Axis = Axis;
  static Level = Level;
  state: string = Status.Open;
  scale: number = Axis.Log;
  isDone(s: string): boolean { return s === Status.Done; }
  pick(axis: number = Axis.Linear): number { return axis; }
  level(): number { return Level.High; }
}

const c = new Card();
console.log(c.Status.Done, c.Axis.Linear, Card.Level.High, Card.Level[Card.Level.Low]);
console.log(c.state, c.scale, c.isDone('done'), c.isDone('open'), c.pick(), c.pick(2), c.level());
console.log(Object.keys(c.Status).join(), Object.values(c.Axis).join());
