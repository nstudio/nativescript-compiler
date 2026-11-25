// @app-lenient
// @cli-program
// A non-strict app's string parameter takes undefined where the program gives one (an optional field left out, an untyped
// caller of a typed callback), and a guarded optional field or record entry, or a typed caller's string, brings none:
// each is passed on as given.
interface Project {
  name: string;
  website?: string;
  repo?: string;
}
function open(url: string): string {
  return /^https?:\/\//i.test(url) ? `in-app ${url}` : `external ${url}`;
}
function view(p: Project): string {
  if (!p.website) return 'no site';
  return open(p.website);
}
function advisories(p: Project): string {
  return open(p.repo);
}
function onLinkTap(url: string): string {
  return open(url);
}
function zone(tzid: string): string {
  return tzid === 'UTC' ? 'Z' : `@${tzid}`;
}
function startZone(line: string): string {
  const params: Record<string, string> = {};
  for (const kv of line.split(';')) {
    const [k, v] = kv.split('=');
    params[k] = v;
  }
  const ev: Partial<Project & { tzid: string }> = { tzid: 'UTC' };
  if (params['TZID']) ev.tzid = params['TZID'];
  return zone(ev.tzid);
}
function shout(s: string): string {
  return `${s}!`;
}
const handlers = { linkTap: (url: string) => onLinkTap(url) };
const callWithNothing: any = (f: (s: string) => string) => f(undefined);
const bare: Project = { name: 'bare' };
const full: Project = { name: 'full', website: 'https://openjsf.org', repo: 'https://github.com/nodejs/node' };
console.log(view(bare), view(full), advisories(bare), advisories(full));
console.log(handlers.linkTap('mailto:cpc@openjsf.org'), handlers.linkTap('https://nativescript.org'));
console.log(startZone('DTSTART;TZID=Europe/Oslo'), startZone('DTSTART'), callWithNothing((s: string) => shout(s)));
