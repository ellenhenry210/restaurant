// Every price/total the API returns is a Postgres DECIMAL, serialized as
// a string ("3500.00") — Number(...) here, not a fix to the API. Formats
// using whatever `currency` the restaurant actually returned rather than
// hardcoding NGN, since a restaurant's own currency (meals.currency) is
// itself part of the data model.
export function formatMoney(amount, currency = 'NGN') {
  const value = Number(amount);
  if (Number.isNaN(value)) return String(amount);
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(value);
  } catch {
    // An unrecognized currency code would make Intl.NumberFormat throw —
    // fall back to a plain number rather than crashing the page over it.
    return value.toFixed(2);
  }
}
