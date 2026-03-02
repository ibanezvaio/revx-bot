# News Signal Engine Runbook

## Purpose
The news engine is a risk-posture input, not a directional alpha bot. It reduces adverse selection during shocks by widening spreads, cutting size, optionally gating one side, and temporarily pausing makers when impact/confidence are extreme.

## Sources
Default providers:
- RSS: CoinDesk, Cointelegraph, Reuters Business, The Block, CryptoPanic, Yahoo Finance
- GDELT 2.1 DOC API
- NewsAPI (optional, only when `NEWSAPI_KEY` is set)

Use:
- `GET /api/news` for latest scored headlines + aggregate
- `GET /api/debug/news` for provider health, fetch durations, dedupe stats, and last error

## Scoring Model
Each headline is scored deterministically:
- `impact` in `[0..1]` from keyword classes (war, rates, hacks, outages, regulation, ETF, liquidation)
- `direction`: `UP | DOWN | NEUTRAL`
- `confidence` in `[0..1]` from keyword strength, source tier, and cross-source similarity
- category: `macro | war | rates | crypto | regulation | exchange | outage | other`

Aggregate signal applies exponential decay:
- weight per headline `exp(-age / NEWS_HALF_LIFE_MS)`
- aggregate impact normalized to `[0..1]`
- aggregate direction from weighted signed score

## Trading Posture Mapping
`NewsGuard` returns one of:
- `NORMAL`
- `CAUTION`
- `RISK_OFF`
- `RISK_ON`
- `PAUSE`

Effects:
- spread multiplier: `1 + NEWS_SPREAD_MULT * impact`
- size multiplier: `1 - NEWS_SIZE_CUT_MULT * impact` (floored in strategy)
- optional side gating under inventory stress (`RISK_OFF` or `RISK_ON`)
- maker pause cooldown when `impact >= NEWS_PAUSE_IMPACT` and `confidence >= NEWS_MIN_CONF`

## Tuning Guidance
If posture is too sensitive:
- raise `NEWS_MIN_CONF`
- raise `NEWS_PAUSE_IMPACT`
- lower `NEWS_SPREAD_MULT` and `NEWS_SIZE_CUT_MULT`

If posture is too slow during macro shocks:
- lower `NEWS_PAUSE_IMPACT`
- lower `NEWS_MIN_CONF` slightly
- lower `NEWS_HALF_LIFE_MS` for faster decay/reaction balance

Suggested starting ranges:
- `NEWS_MIN_CONF`: `0.60..0.75`
- `NEWS_PAUSE_IMPACT`: `0.80..0.92`
- `NEWS_SPREAD_MULT`: `0.50..1.00`
- `NEWS_SIZE_CUT_MULT`: `0.40..0.70`

## Operational Checks
1. Confirm engine health:
   - `/api/debug/news` should show provider entries with `ok=true` for at least one source.
2. Confirm aggregate not stuck:
   - `/api/news` aggregate `impact/direction/confidence` should update over time.
3. Confirm strategy wiring:
   - `/api/status` analytics should include `newsImpact`, `newsDirection`, `newsConfidence`, `newsState`, `newsLastTs`.
4. Confirm quote reasons:
   - `/api/status` `botStatus.quoting.newsReasons` shows posture reasons when active.

## Limitations
- Public feeds can be delayed, noisy, or rate-limited.
- Headline heuristics are keyword-based and may miss context or sarcasm.
- News signal is not guaranteed predictive and should not be treated as a standalone trading edge.

## Recommended Upgrade Path
For production upgrades beyond public feeds:
- add premium low-latency headline feeds (multi-source normalized wire)
- add entity linking + event clustering pipeline
- add historical event outcome calibration per category/source
- add explicit source reliability scoring with decay over time
