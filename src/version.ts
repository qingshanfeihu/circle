export const VERSION = '1.0.4';
export function validVersion(value: string): boolean {
  return (
    value === value.trim() &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  );
}
export function compareVersions(a: string, b: string): number {
  if (!validVersion(a) || !validVersion(b))
    throw new Error('invalid semantic version');
  const parts = (value: string) => {
    const [base, ...pre] = value.split('+')[0]!.split('-');
    return {
      base: base!.split('.').map(BigInt),
      pre: pre.length ? pre.join('-').split('.') : [],
    };
  };
  const left = parts(a),
    right = parts(b);
  for (let i = 0; i < 3; i++)
    if (left.base[i] !== right.base[i])
      return left.base[i]! > right.base[i]! ? 1 : -1;
  if (!left.pre.length || !right.pre.length)
    return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
