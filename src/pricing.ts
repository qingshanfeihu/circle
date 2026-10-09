import type { ModelFacts, Rates } from './model_catalog.js';
import type { Usage, Message } from './types.js';
export interface PriceReceipt {
  model: string;
  currency: string;
  amount: number | null;
  tokens: {
    input_miss: number;
    input_hit: number;
    input_write: number;
    input_write_1h: number;
    output: number;
  };
  rates: Rates;
  provider: string;
}
const count = (n: unknown): number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
export function priceCall(facts: ModelFacts, usage: Usage): PriceReceipt {
  const input = count(usage.input_tokens);
  const hit = Math.min(input, count(usage.cache_read_tokens));
  const write = Math.min(input - hit, count(usage.cache_write_tokens));
  const tokens = {
    input_miss: input - hit - write,
    input_hit: hit,
    input_write: write,
    input_write_1h: Math.min(write, count(usage.cache_write_1h_tokens)),
    output: count(usage.output_tokens),
  };
  const base = facts.rates;
  const rates =
    input > 200_000 &&
    base?.context_over_200k?.input !== undefined &&
    base.context_over_200k.output !== undefined
      ? base.context_over_200k
      : base;
  let amount: number | null = null;
  if (rates?.input !== undefined && rates.output !== undefined) {
    const value =
      (tokens.input_miss * rates.input +
        hit * (rates.cache_read || rates.input) +
        write * (rates.cache_write || rates.input) +
        tokens.output * rates.output) /
      1_000_000;
    if (Number.isFinite(value) && value >= 0) amount = value;
  }
  return {
    model: facts.model,
    currency:
      base?.input !== undefined && base.output !== undefined ? 'USD' : '',
    amount,
    tokens,
    rates: base ? structuredClone(base) : {},
    provider: facts.priceProvider,
  };
}
export interface CostSummary {
  amounts: Record<string, number>;
  calls: number;
  unpriced_calls: number;
}
export class UsageCostTotals {
  private summary: CostSummary = { amounts: {}, calls: 0, unpriced_calls: 0 };
  add(receipt: unknown): void {
    this.summary.calls++;
    const r = receipt as Partial<PriceReceipt> | undefined;
    if (
      !r ||
      typeof r.amount !== 'number' ||
      !Number.isFinite(r.amount) ||
      r.amount < 0 ||
      !['USD', 'RMB'].includes(r.currency ?? '')
    ) {
      this.summary.unpriced_calls++;
      return;
    }
    this.summary.amounts[r.currency!] =
      (this.summary.amounts[r.currency!] ?? 0) + r.amount;
  }
  snapshot(): CostSummary {
    return structuredClone(this.summary);
  }
}
export function messageCosts(messages: Message[]): CostSummary {
  const total = new UsageCostTotals();
  for (const message of messages) if (message.usage) total.add(message.cost);
  return total.snapshot();
}
export function formatCosts(
  summaries: CostSummary[],
  knownEmpty = false,
): string {
  const amounts: Record<string, number> = {};
  let calls = 0,
    unpriced = 0;
  for (const summary of summaries) {
    calls += count(summary.calls);
    unpriced += count(summary.unpriced_calls);
    for (const [currency, amount] of Object.entries(summary.amounts))
      if (
        ['USD', 'RMB'].includes(currency) &&
        Number.isFinite(amount) &&
        amount >= 0
      )
        amounts[currency] = (amounts[currency] ?? 0) + amount;
  }
  const text = ['USD', 'RMB']
    .filter((currency) => Object.hasOwn(amounts, currency))
    .map(
      (currency) =>
        `${currency === 'USD' ? '$' : '¥'}${amounts[currency]!.toFixed(4)}`,
    )
    .join(' + ');
  return text
    ? text + (unpriced ? '+' : '')
    : calls
      ? 'N/A'
      : knownEmpty
        ? '$0.0000'
        : 'N/A';
}
