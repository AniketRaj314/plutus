// Node 22 ships the ICU currency catalogue. Accept its recognised ISO codes,
// rather than treating any three letters as a currency.
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

// These aliases belong to the Indian AmEx alert format, not a global currency
// detector. Preserve its established bare $ = USD and yen symbol = JPY rules.
// Other ambiguous symbols (for example kr or P) require an explicit ISO code.
const ALIASES: Record<string, string> = {
  "US$": "USD", "$": "USD",
  "SG$": "SGD", "S$": "SGD",
  "₹": "INR", "RS.": "INR", "RS": "INR",
  "RM": "MYR",
  "฿": "THB",
  "₱": "PHP",
  "€": "EUR",
  "£": "GBP",
  "AU$": "AUD", "A$": "AUD",
  "CA$": "CAD", "C$": "CAD",
  "HK$": "HKD",
  "NZ$": "NZD",
  "NT$": "TWD",
  "JP¥": "JPY", "¥": "JPY",
  "CN¥": "CNY",
};

const TOKENS = [...CURRENCY_CODES, ...Object.keys(ALIASES)]
  .sort((a, b) => b.length - a.length)
  .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const PREFIX = new RegExp(`^(${TOKENS})\\s*(.+)$`, "i");
const SUFFIX = new RegExp(`^(.+?)\\s*(${TOKENS})$`, "i");

// AmEx uses a decimal point, with optional Western or Indian comma grouping.
// Reject decimal commas and malformed grouping instead of silently changing
// the amount by removing every comma. Currency-specific rounding is not ours
// to infer from an issuer alert, so preserve the supplied decimal precision.
const NUMBER = /^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.\d+)?$/;

export function parseAmexAmount(value: string): { currency: string; amount: number } | null {
  const normalized = value.replace(/[\u00a0\u202f]/g, " ").trim();
  const prefix = normalized.match(PREFIX);
  const suffix = prefix ? null : normalized.match(SUFFIX);
  if (!prefix && !suffix) return null;
  const token = (prefix ? prefix[1] : suffix![2]).toUpperCase();
  const digits = (prefix ? prefix[2] : suffix![1]).trim();
  if (!NUMBER.test(digits)) return null;
  const amount = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  return { currency: ALIASES[token] ?? token, amount };
}
