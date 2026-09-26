/**
 * Exchange rates on the server, for one job: state every catalogue price in
 * the same currency.
 *
 * The catalogue's prices are numbers in a column, and everything downstream
 * reads them as dollars — the browse filter, the stylist's budget and the
 * search RPCs all compare `price_min` against `max_price_usd` directly. A
 * product imported from a store that prices in hryvnia therefore arrived as
 * four thousand *dollars*, and nothing downstream had any way to tell. So the
 * conversion belongs at import, before the number is written, rather than in
 * the page that displays it.
 *
 * Rates are quoted the way `open.er-api.com` quotes them — how many units of a
 * currency one dollar buys, so `rates.UAH = 41` means $1 = ₴41 and a hryvnia
 * price is divided by it. The whole table is kept rather than the handful the
 * currency switcher offers: a store can price in złoty or won whether or not a
 * shopper can ask to *see* złoty, and refusing to convert what we cannot
 * display is how a wrong number gets into the catalogue.
 *
 * `src/lib/context/currency-context.tsx` keeps its own copy of the fallback
 * numbers. That is deliberate rather than a duplicate to clean up: it is a
 * browser file, offline when this route is what it cannot reach.
 */

/** How long a fetched table is reused before asking again. */
const TTL_MS = 3_600_000;

/** Rates to fall back on, USD base, when the provider is unreachable. */
export const FALLBACK_RATES: Record<string, number> = {
  EUR: 0.85, GBP: 0.74, UAH: 41, CZK: 21, JPY: 157, TRY: 45,
  PLN: 3.6, SEK: 9.5, NOK: 10.2, DKK: 6.4, CHF: 0.8, CAD: 1.37,
  AUD: 1.5, NZD: 1.65, RUB: 80, INR: 88, CNY: 7.1, KRW: 1380,
  HKD: 7.8, SGD: 1.28, AED: 3.67, BRL: 5.4, MXN: 18.5, ILS: 3.3,
  RON: 4.3, HUF: 335, BGN: 1.66, ZAR: 17.5, THB: 32, TWD: 30,
};

export interface UsdRates {
  /** Units of the currency per 1 USD. */
  rates: Record<string, number>;
  /** The day the provider last updated the table, `YYYY-MM-DD`. */
  asOf: string;
  /** False when these are the fallback numbers rather than the provider's. */
  live: boolean;
}

let cache: { at: number; value: UsdRates } | null = null;
/** In-flight request, so a burst of imports makes one call rather than twenty. */
let inFlight: Promise<UsdRates> | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fallback(): UsdRates {
  return { rates: FALLBACK_RATES, asOf: today(), live: false };
}

async function fetchRates(): Promise<UsdRates> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      result?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    if (data.result !== "success" || !data.rates) throw new Error("bad response");

    // Keep only the numbers that can divide a price. A zero or a NaN in the
    // table would turn one product's price into Infinity, which is worse than
    // not converting it at all.
    const rates: Record<string, number> = {};
    for (const [code, value] of Object.entries(data.rates)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        rates[code.toUpperCase()] = value;
      }
    }
    if (!rates.EUR) throw new Error("table looks empty");

    const stamp = data.time_last_update_utc ? new Date(data.time_last_update_utc) : new Date();
    const asOf = Number.isNaN(stamp.getTime()) ? today() : stamp.toISOString().slice(0, 10);
    return { rates, asOf, live: true };
  } catch {
    return fallback();
  }
}

/**
 * The rate table, cached for an hour.
 *
 * A failed fetch is cached too, and on purpose: a provider that is down stays
 * down for more than one product, and an import run should not spend a network
 * timeout per page discovering that again.
 */
export async function usdRates(): Promise<UsdRates> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  inFlight = fetchRates()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export interface Converted {
  /** The amount in dollars, to the cent. */
  usd: number;
  /** The rate used — units of the source currency per 1 USD. */
  rate: number;
  /** The day that rate is from, `YYYY-MM-DD`. */
  asOf: string;
  /** False when the rate came from the fallback table. */
  live: boolean;
}

/**
 * One amount, in dollars.
 *
 * Returns null rather than a guess when the currency is unknown to the
 * provider — an unconvertible price is a price to leave alone and say so
 * about, not one to quietly relabel.
 */
export async function toUsd(amount: number, currency: string): Promise<Converted | null> {
  const code = (currency ?? "").trim().toUpperCase();
  if (!code || !Number.isFinite(amount)) return null;

  const { rates, asOf, live } = await usdRates();
  if (code === "USD") return { usd: round2(amount), rate: 1, asOf, live };

  const rate = rates[code];
  if (!rate || rate <= 0) return null;

  return { usd: round2(amount / rate), rate, asOf, live };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface Offer {
  amount: number;
  /** ISO code the amount is in. */
  currency: string;
}

/**
 * The cheapest of a product's offers, in the currency that store charges.
 *
 * A retailer entry keeps the store's own number — ₴4 000 on a hryvnia store —
 * because that is what a shopper clicking through will be asked to pay. Taking
 * the smallest of those numbers and printing it with the product's currency is
 * how the product page came to say "From $4,000" above a retailer row reading
 * "$97.56". So the offers are compared in dollars and the winner is handed back
 * with its own currency, for the display to convert like any other price.
 *
 * `fallback` is the product's own price, for a product with no priced offers.
 */
export async function cheapestOffer(
  offers: { price: number; currency?: string }[],
  fallback: Offer,
): Promise<Offer> {
  const priced = offers
    .filter((o) => Number.isFinite(o.price) && o.price > 0)
    .map((o) => ({ amount: o.price, currency: (o.currency || "USD").trim().toUpperCase() }));
  if (!priced.length) return fallback;

  // One currency needs no rates, and that is nearly every product.
  if (priced.every((o) => o.currency === priced[0].currency)) {
    return priced.reduce((min, o) => (o.amount < min.amount ? o : min));
  }

  const { rates } = await usdRates();
  const inUsd = (o: Offer) => {
    if (o.currency === "USD") return o.amount;
    const rate = rates[o.currency];
    // An offer we cannot put on the dollar scale cannot be compared; it is
    // still shown in the retailer list, it just never wins "From".
    return rate && rate > 0 ? o.amount / rate : Infinity;
  };
  const best = priced.reduce((min, o) => (inUsd(o) < inUsd(min) ? o : min));
  return Number.isFinite(inUsd(best)) ? best : fallback;
}
