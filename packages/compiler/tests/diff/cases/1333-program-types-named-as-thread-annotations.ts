// Program classes named as the thread annotations Kotlin files import by name (androidx's `UiThread`, `AnyThread`):
// each stays the program's own class.
class UiThread {
  private jobs: string[] = [];
  post(job: string) { this.jobs.push(job); return this; }
  get pending() { return this.jobs.length; }
}
class AnyThread { constructor(readonly id: number) {} }
const ui = new UiThread().post('layout').post('draw');
const workers = [new AnyThread(1), new AnyThread(2)];
console.log(ui.pending, ui instanceof UiThread, workers.map((w) => w.id).join('+'), workers[0] instanceof AnyThread);
