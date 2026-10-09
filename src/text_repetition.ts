export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(
      /([\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef])/gu,
      ' $1 ',
    )
    .trim()
    .split(' ')
    .filter(Boolean);
}
function periodScore(
  tokens: string[],
  period: number,
  repeats: number,
  samples = 0,
): number {
  const need = period * repeats;
  if (period <= 0 || tokens.length < need) return 0;
  const tail = tokens.slice(-need);
  const span = need - period;
  const step = samples ? Math.max(1, Math.floor(span / samples)) : 1;
  let matches = 0;
  let total = 0;
  for (let index = 0; index < span; index += step) {
    total++;
    if (tail[index] === tail[index + period]) matches++;
  }
  return total ? matches / total : 0;
}
export function cycleNovelty(
  tokens: string[],
  period: number,
  repeats: number,
): number {
  const need = period * repeats;
  if (period <= 0 || tokens.length < need) return 1;
  const tail = tokens.slice(-need);
  const prior = new Set(tail.slice(0, -period));
  return (
    tail.slice(-period).filter((token) => !prior.has(token)).length / period
  );
}
export interface RepetitionOptions {
  minBlock?: number;
  repeats?: number;
  tolerance?: number;
  maxNovelty?: number;
  windowTokens?: number;
  checkEvery?: number;
}
export function periodicTailPeriod(
  tokens: string[],
  options: RepetitionOptions = {},
): number | undefined {
  const min = options.minBlock ?? 8;
  const repeats = options.repeats ?? 4;
  const tolerance = options.tolerance ?? 0.9;
  if (min <= 0 || repeats < 2 || tokens.length < min * repeats)
    return undefined;
  for (
    let period = min;
    period <= Math.floor(tokens.length / repeats);
    period++
  )
    if (
      periodScore(tokens, period, repeats, 64) >= tolerance &&
      periodScore(tokens, period, repeats) >= tolerance &&
      new Set(tokens.slice(-period)).size >= 3 &&
      cycleNovelty(tokens, period, repeats) <= (options.maxNovelty ?? 0)
    )
      return period;
  return undefined;
}
export class RepetitionMonitor {
  private tokens: string[] = [];
  private residual = '';
  private sinceCheck = 0;
  constructor(readonly options: RepetitionOptions = {}) {}
  feed(text: string): number | undefined {
    let buffer = this.residual + text;
    if (buffer && !/\s$/u.test(buffer)) {
      const cut = Math.max(
        buffer.lastIndexOf(' '),
        buffer.lastIndexOf('\n'),
        buffer.lastIndexOf('\t'),
      );
      if (cut < 0 && Array.from(buffer).length <= 256) {
        this.residual = buffer;
        return undefined;
      }
      this.residual = cut >= 0 ? buffer.slice(cut + 1) : '';
      if (cut >= 0) buffer = buffer.slice(0, cut + 1);
    } else this.residual = '';
    const fresh = tokenize(buffer);
    if (!fresh.length) return undefined;
    this.tokens.push(...fresh);
    this.tokens = this.tokens.slice(-(this.options.windowTokens ?? 4000));
    this.sinceCheck += fresh.length;
    if (this.sinceCheck < Math.max(1, this.options.checkEvery ?? 200))
      return undefined;
    this.sinceCheck = 0;
    return periodicTailPeriod(this.tokens, this.options);
  }
}
