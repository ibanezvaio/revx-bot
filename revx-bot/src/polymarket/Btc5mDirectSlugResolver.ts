import { Logger } from "../logger";
import { PolymarketClient, RawPolymarketMarket } from "./PolymarketClient";

export type Btc5mDirectLookupRow = {
  row: Record<string, unknown>;
  slug: string;
  source: "slug_query" | "search_query";
};

export type Btc5mDirectLookupResult = {
  attemptedSlugs: string[];
  rows: Btc5mDirectLookupRow[];
  hadNetworkError: boolean;
  hadData: boolean;
};

export class Btc5mDirectSlugResolver {
  constructor(
    private readonly client: PolymarketClient,
    private readonly logger: Logger
  ) {}

  async lookupBySlugs(slugs: string[]): Promise<Btc5mDirectLookupResult> {
    const attemptedSlugs = Array.from(
      new Set(
        slugs
          .map((value) => String(value || "").trim())
          .filter((value) => value.length > 0)
      )
    );
    const rows: Btc5mDirectLookupRow[] = [];
    const seen = new Set<string>();
    let hadNetworkError = false;

    const appendRows = (
      slug: string,
      source: Btc5mDirectLookupRow["source"],
      rawRows: RawPolymarketMarket[]
    ): void => {
      for (const raw of rawRows) {
        const row = raw as Record<string, unknown>;
        const marketId = pickString(row, ["id", "market_id", "conditionId", "condition_id"]);
        const rowSlug = pickString(row, ["slug", "market_slug", "eventSlug", "event_slug"]);
        const key = `${marketId}::${rowSlug}`.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push({ row, slug, source });
      }
    };

    for (const slug of attemptedSlugs) {
      let bySlug: RawPolymarketMarket[] = [];
      try {
        const page = await this.client.listMarketsPage({
          limit: 100,
          slug,
          active: true,
          closed: false,
          archived: false
        });
        bySlug = Array.isArray(page.rows) ? page.rows : [];
      } catch (error) {
        hadNetworkError = true;
        this.logger.warn(
          {
            slug,
            error: shortErrorMessage(error)
          },
          "Direct BTC5m slug lookup failed"
        );
      }

      appendRows(slug, "slug_query", bySlug);
      if (bySlug.length > 0) {
        continue;
      }

      try {
        const page = await this.client.listMarketsPage({
          limit: 100,
          search: slug,
          active: true,
          closed: false,
          archived: false
        });
        appendRows(slug, "search_query", Array.isArray(page.rows) ? page.rows : []);
      } catch (error) {
        hadNetworkError = true;
        this.logger.warn(
          {
            slug,
            error: shortErrorMessage(error)
          },
          "Direct BTC5m search lookup failed"
        );
      }
    }

    return {
      attemptedSlugs,
      rows,
      hadNetworkError,
      hadData: rows.length > 0
    };
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function shortErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown_error");
}
