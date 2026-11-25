// A program interface named as the Swift type a native block hands over (NSNotificationCenter's observer block takes
// Swift's `Notification`): the block keeps the native type, and the program's objects keep theirs.
interface Notification { title: string; unread: boolean }
const inbox: Notification[] = [{ title: 'hello', unread: true }, { title: 'later', unread: false }];
const native = typeof NSNotificationCenter !== 'undefined';
let observed = 0;
if (native) {
  const center = NSNotificationCenter.defaultCenter;
  const token = center.addObserverForNameObjectQueueUsingBlock('ns.case.ping', null, NSOperationQueue.mainQueue, (n: NSNotification) => { if (n.name === 'ns.case.ping') observed++; });
  center.postNotificationNameObject('ns.case.ping', null);
  setTimeout(() => center.removeObserver(token), 100);
} else {
  observed = 1;
}
const unread = inbox.filter((n) => n.unread).map((n) => n.title);
setTimeout(() => console.log(unread.join(','), observed), 50);
