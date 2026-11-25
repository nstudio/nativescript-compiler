// Parenthesized reads of class fields narrower than their interface's optional members (as generated template code
// writes them), once script writes undefined through the interface: each is tested and defaulted as JavaScript does.
interface Toast {
  showCancel?: boolean;
  padTop?: number;
  label?: string;
}
class ToastView implements Toast {
  showCancel: boolean = true;
  padTop: number = 4;
  label: string = 'ok';
  cancelShown() {
    return !(!(this.showCancel));
  }
  hidden() {
    return !(this.showCancel);
  }
  style() {
    return `padding-top: ${(this.padTop) ?? ''}; label: ${(this.label) ?? 'none'}`;
  }
  pick() {
    return (this.showCancel) ? (this.label) : 'no';
  }
}
const t = new ToastView();
console.log(t.cancelShown(), t.hidden(), t.style(), t.pick());
const o: Toast = t;
o.showCancel = undefined;
o.padTop = undefined;
o.label = undefined;
console.log(t.cancelShown(), t.hidden(), t.style(), t.pick(), JSON.stringify(t));
