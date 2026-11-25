// Constant objects compared as `switch` and `===` compare them: by identity, so an equal copy matches no case.
const Moods = { Calm: { main: 'blue', text: 'white' }, Angry: { main: 'red', text: 'black' } };
type Mood = (typeof Moods)[keyof typeof Moods];

function label(m: Mood): string {
  switch (m) {
    case Moods.Calm:
      return 'calm';
    case Moods.Angry:
      return 'angry';
    default:
      return 'other';
  }
}

function fallsThrough(m: Mood | undefined): string {
  let out = '';
  switch (m) {
    case Moods.Calm:
    case Moods.Angry:
      out += 'known';
      break;
    default:
      out += 'unknown';
  }
  return out;
}

const copy: Mood = { main: 'red', text: 'black' };
const picked: Mood = Moods.Angry;
console.log(label(Moods.Calm), label(picked), label(copy));
console.log(fallsThrough(Moods.Calm), fallsThrough(copy), fallsThrough(undefined));
console.log(picked === Moods.Angry, picked === copy, picked !== Moods.Calm);
