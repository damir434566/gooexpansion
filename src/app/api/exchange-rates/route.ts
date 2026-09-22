import { NextResponse } from "next/server";
import { usdRates, FALLBACK_RATES } from "@/lib/server/fx";

/**
 * The rates the currency switcher offers.
 *
 * The table itself is fetched and cached by `@/lib/server/fx`, which the
 * importer uses to state prices in dollars — the same numbers, from one place,
 * so a product's stored price and the price a shopper sees converted cannot
 * disagree. This route narrows that table to the currencies the switcher has a
 * symbol for and hands it to the browser.
 */
const CODES = ["EUR", "GBP", "UAH", "CZK", "JPY", "TRY"];

function pick(rates: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    CODES.map((c) => [c, rates[c]]).filter(([, v]) => typeof v === "number"),
  );
}

export async function GET() {
  const { rates, live } = await usdRates();

  // A fallback table is cached briefly, so the switcher picks live numbers up
  // soon after the provider comes back rather than an hour later.
  return NextResponse.json(pick(live ? rates : FALLBACK_RATES), {
    headers: {
      "Cache-Control": live
        ? "public, s-maxage=3600, stale-while-revalidate=600"
        : "public, s-maxage=300",
    },
  });
}
