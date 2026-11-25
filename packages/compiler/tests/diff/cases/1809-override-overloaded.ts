// An override of an overloaded method overrides its implementation, the one JavaScript has; default parameters are
// each body's own.
class Shape {
	describe(x: number): string;
	describe(x: string): string;
	describe(x: number | string): string {
		return 'shape ' + x;
	}
	scale(by: number = 2): number {
		return by;
	}
}

class Circle extends Shape {
	describe(x: number | string): string {
		return 'circle / ' + super.describe(x as number);
	}
	scale(by: number = 3): number {
		return by * 10;
	}
}

const shapes: Shape[] = [new Shape(), new Circle()];
for (const s of shapes) console.log(s.describe(1), s.describe('two'), s.scale(), s.scale(5));
