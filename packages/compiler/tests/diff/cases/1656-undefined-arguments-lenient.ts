// @app-lenient
// @cli-program
// A non-strict app passes an optional field's undefined to a parameter typed string, number or boolean: the parameter
// holds undefined, as JavaScript passes it, and converts it only where JavaScript does. A record's missing entry asserted
// its type is undefined for `??`.
interface Ev {
  start: string;
  tzid?: string;
  minutes?: number;
  allDay?: boolean;
}
function wallToUtc(wall: string, tz: string): string {
  return tz === undefined ? wall + 'Z' : wall + '@' + tz;
}
function span(minutes: number, allDay: boolean): string {
  return `${minutes === undefined ? 'U' : minutes}/${allDay === undefined ? 'U' : allDay}/${minutes + 1}`;
}
function lower(s: string): string {
  try {
    return s.toLowerCase();
  } catch (e) {
    return (e as Error).name;
  }
}
const ev: Ev = { start: '10:00' };
const timed: Ev = { start: '11:00', tzid: 'Europe/Oslo', minutes: 30, allDay: false };
for (const e of [ev, timed]) console.log(wallToUtc(e.start, e.tzid), span(e.minutes, e.allDay), lower(e.tzid));

type Freq = 'DAILY' | 'WEEKLY';
function freqOf(line: string): Freq {
  const parts: Record<string, string> = {};
  for (const kv of line.split(';')) {
    const [k, v] = kv.split('=');
    parts[k] = v;
  }
  return (parts['FREQ'] as Freq) ?? 'WEEKLY';
}
console.log(freqOf('COUNT=2'), freqOf('FREQ=DAILY'));
