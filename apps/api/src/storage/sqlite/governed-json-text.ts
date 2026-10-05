import { createHash } from 'node:crypto';
import { canonicalGovernedJsonV1 } from '../../lib/governed-content-digest.js';

class DecimalToken {
  constructor(readonly canonical: string) {}
}

/** Match PostgreSQL numeric/trim_scale without a binary64 conversion. */
function decimal(source: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error('Invalid JSON decimal');
  const integer = match[2]!, fraction = match[3] ?? '';
  const combined = integer + fraction;
  const leading = combined.length - combined.replace(/^0+/, '').length;
  const exponent = Number(match[4] ?? 0);
  // JSONB validates the original scale even when trim_scale would remove zeros.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 2147483647 || fraction.length - exponent > 16383) {
    throw new Error('JSON decimal exceeds PostgreSQL numeric range');
  }
  if (leading === combined.length) return '0';
  const point = integer.length + exponent - leading;
  const digits = combined.slice(leading).replace(/0+$/, '');
  // PostgreSQL's unconstrained numeric domain, including JSONB numeric values.
  if (!Number.isSafeInteger(point) || point > 131072 || digits.length - point > 16383) {
    throw new Error('JSON decimal exceeds PostgreSQL numeric range');
  }
  const value = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return match[1] + value;
}

function canonical(value: unknown): string {
  if (value instanceof DecimalToken) return value.canonical;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${canonicalGovernedJsonV1(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return canonicalGovernedJsonV1(value);
}

/** Node 24 reviver source text retains decimals JSON.parse otherwise rounds. */
export function canonicalGovernedJsonText(source: string): string {
  // A reviver sees only the surviving duplicate key. Validate every literal,
  // including overwritten values, as PostgreSQL does when reading JSONB.
  for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const literal = match[0];
    if (literal.startsWith('"')) canonicalGovernedJsonV1(JSON.parse(literal));
    else decimal(literal);
  }
  return canonical(JSON.parse(source, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (context?.source === undefined) throw new Error('Exact JSON numeric source unavailable');
    return new DecimalToken(decimal(context.source));
  }));
}
export function analysisJsonTextDigest(source: string): string {
  return `sha256:${createHash('sha256').update(canonicalGovernedJsonText(source), 'utf8').digest('hex')}`;
}
export function governedJsonTextDigest(kind: string, source: string): string {
  const bytes = `{"content":${canonicalGovernedJsonText(source)},"kind":${canonicalGovernedJsonV1(kind)}}`;
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}
