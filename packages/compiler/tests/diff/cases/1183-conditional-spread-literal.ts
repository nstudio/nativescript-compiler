// Literals spread conditionally into a typed object: each operand keeps its own shape, not the whole object's.
interface Plan { monthly?: number; annual?: number }
interface Order { id: string; plan: Plan; note?: string }

function order(id: string, monthly: number | undefined, note: string | undefined): Order {
  return {
    id,
    plan: { ...(monthly ? { monthly } : {}), ...(monthly && monthly > 10 ? { annual: monthly * 10 } : {}) },
    ...(note !== undefined ? { note } : {}),
  };
}

for (const o of [order('a', 5, 'x'), order('b', undefined, undefined), order('c', 20, undefined)]) {
  console.log(o.id, o.plan.monthly, o.plan.annual, o.note, JSON.stringify(o));
}
