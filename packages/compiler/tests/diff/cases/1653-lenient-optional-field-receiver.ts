// @app-lenient
// @cli-program
// A non-strict app's optional field read as present (`meeting.host.name` of `host?: Person`), asserted or not: JavaScript's
// TypeError where it was never set, which the program catches.
interface Person { name: string }
interface Meeting { title: string; host?: Person }
function hostName(m: Meeting): string {
  try {
    return m.host.name;
  } catch (e) {
    return (e as Error).name + ': ' + (e as Error).message;
  }
}
function asserted(m: Meeting): string {
  try {
    return m.host!.name;
  } catch (e) {
    return (e as Error).name + ': ' + (e as Error).message;
  }
}
const meetings: Meeting[] = [{ title: 'a', host: { name: 'Ann' } }, { title: 'b' }];
console.log(meetings.map(hostName).join(' | '));
console.log(meetings.map(asserted).join(' | '));
