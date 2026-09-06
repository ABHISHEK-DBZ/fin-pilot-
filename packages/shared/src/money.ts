/**
 * Money helpers. All amounts are stored as REAL rupees (INR), rounded to 2 decimals
 * via integer paise math to avoid float drift.
 */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Indian digit grouping: 1840000 -> "18,40,000" */
export function groupIndian(n: number): string {
  const neg = n < 0;
  let s = Math.round(Math.abs(n)).toString();
  if (s.length > 3) {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    s = parts.join(',') + ',' + last3;
  }
  return (neg ? '-' : '') + s;
}

export function formatINR(n: number, withDecimals = false): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  const rup = Math.floor(abs);
  const pai = Math.round((abs - rup) * 100);
  let out = `₹${groupIndian(rup)}`;
  if (withDecimals || pai > 0) out += `.${pai.toString().padStart(2, '0')}`;
  return (neg ? '-' : '') + out;
}

/** Convert amount to lakh units, e.g. 1840000 -> 18.4 */
export function toLakh(n: number): number {
  return Math.round((n / 100000) * 100) / 100;
}
