// Function literals whose slot returns void: an async one's promise and an assignment's value are not results.
class Fader {
  opacity = 1;
  animate(): Promise<void> { return Promise.reject(new Error('stopped')); }
}

class Resumer {
  handler: ((data?: { name: string }) => void) | null = null;
  log: string[] = [];
  register(): void {
    this.handler = async () => {
      this.handler = null;
      await Promise.resolve();
      this.log.push('resumed');
    };
  }
}

const f = new Fader();
f.animate().catch(() => (f.opacity = 0.8)).then(() => console.log('opacity', f.opacity));
const r = new Resumer();
r.register();
r.handler?.({ name: 'x' });
console.log(r.handler === null);
setTimeout(() => console.log(r.log.join(',')), 10);
