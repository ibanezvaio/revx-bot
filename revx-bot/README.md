# revx-bot

Conservative POST_ONLY BTC-USD maker bot for Revolut X REST API.

This repo now runs **MakerStrategy v2**:
- dynamic multi-level quoting
- volatility-aware spread widening
- inventory-skewed pricing around a BTC notional target
- queue refresh + cancel/replace discipline
- metrics and tuning helpers

## Safety First

1. Start in `DRY_RUN=true`.
2. Use small quote size (`LEVEL_QUOTE_SIZE_USD=5..8`).
3. Confirm signatures and endpoint behavior before live trading.
4. Move to live only after observing stable dry-run behavior.

## Revolut X API Key / Private Key

At a high level:
1. Open Revolut X developer/API settings.
2. Create an API key pair for the exchange REST API.
3. Put API key in `REVX_API_KEY`.
4. Provide Ed25519 private key via `REVX_PRIVATE_KEY_BASE64` or `REVX_PRIVATE_KEY_PATH`.

The signer supports:
- raw 32-byte seed (base64)
- raw 64-byte secret key (base64)
- PEM file path

## Setup

```bash
cd /Users/andrewbooth/Documents/projects/revolutx/revx-bot
npm i
cp .env.example .env
npm run build
npm run dev
```

Dashboard:
- `http://127.0.0.1:8787`
- `http://127.0.0.1:8787/intel` (dedicated Intel Console)
- `http://127.0.0.1:8787/performance` (performance analytics + adaptive controls)
- Navigation uses a collapsible icon rail (state persisted in localStorage) and includes a direct Intel page link.

## V1 Control Room UI

The dashboard is now a premium dark "Control Room" layout and preserves all core bot telemetry:
- mission bar: symbol, run id, uptime, last update age, connection, mode
- KPI strip: mid, spread, active orders, trend move, fill edge, realized PnL, execution health, signals
- equity KPIs: total equity in USD/BTC, USD total/free, BTC total/free, BTC notional
- adaptive controller card: current half spread, adaptive delta, and applied reason chips
- session PnL panel: range, span, 24H/12H/4H/1H/15M windows, gating chips, min/max chart markers
- equity panel: USD/BTC toggle chart + 15M/1H/4H/12H/24H windows + composition chart (USD total vs BTC notional in USD)
- drawdown panel: drawdown abs/% chart and max drawdown stats
- balances table, active bot orders table, recent bot order events with filters
- roadmap tab: current/next milestones with readiness indicators (edge, fills/hr, churn, pnl)

Quick actions:
- `Cancel All`
- keyboard shortcuts: `C` (cancel-all confirm), `Esc` (close modal)

## Commands

```bash
npm run dev                      # strategy loop (reads DRY_RUN from env, default true)
npm run live                     # strategy loop with DRY_RUN=false
npm run build                    # TypeScript compile
node dist/cli.js status          # balances, inventory, grouped active orders, fills, decisions
node dist/cli.js balances --raw  # parsed USD/BTC balances + raw balance field mapping
node dist/cli.js cancel-all      # cancel bot-tagged active orders
node dist/cli.js cancel-all --all
node dist/cli.js dry-run         # run one strategy cycle in dry-run mode
node dist/cli.js simulate --minutes 5
npm run polymarket               # start Polymarket BTC-5m module in paper mode
node dist/cli.js polymarket ping --paper
node dist/cli.js polymarket scan --btc5m --debug
node dist/cli.js polymarket resolve-event --slug btc-updown-5m-1772556900
node dist/cli.js polymarket book --token-id <tokenId> --live
node dist/cli.js polymarket ping --live
node dist/cli.js polymarket whoami --live
node dist/cli.js polymarket derive-creds --live
node dist/cli.js polymarket paper --btc5m --hours 12
node dist/cli.js polymarket paper --btc5m --hours 0.2 --force-trade --force-interval-sec 60 --force-notional 1
node dist/cli.js polymarket --btc5m --paper
node dist/cli.js polymarket --btc5m --live --cancel-all-on-start
npm test                         # Polymarket estimator/model/strategy/sizing tests
npm run signal-smoke            # cross-venue fair-price signal smoke test
npm run test:elite-signals      # fair-mid model + regime classifier tests
npm run test:adverse-guard      # adverse-selection guard transition tests
npm run test:news-scorer        # deterministic headline scoring tests
npm run test:news-engine        # decay-weighted aggregate news tests
npm run test:news-guard         # news posture + cooldown tests
npm run test:intel-cluster      # intel clustering + HALT confirmation rules
npm run test:intel-smoke        # smoke test for /intel route (HTTP 200)
npm run test:signals-scorer     # in-process signals scorer tests
npm run test:signals-aggregate  # in-process signals aggregate/state tests
npm run test:signals-guard      # in-process signals guard tests
npm run test:performance-analysis # FIFO/edge/tox performance analytics tests
npm run test:inferred-trades-endpoint # inferred-fill -> /api/analysis/fills integration check
npm run analysis-smoke           # sample fills/snapshots performance summary smoke script
node dist/cli.js tune            # print spread tuning suggestion from last hour
node dist/cli.js tune --apply    # apply BASE_HALF_SPREAD_BPS suggestion to .env
npm run test:cancel-idempotency  # simulate 409 cancel response and verify idempotent handling
npm run test:adaptive-events     # adaptive clamp + side cap + event ring buffer checks
npm run test:runtime-overrides   # set/read/expire/clear runtime overrides smoke test
```

## Polymarket BTC 5m Module

This repo now includes a dedicated `src/polymarket/` engine for BTC 5-minute Up/Down windows.
Use Node `>=20.10` for live CLOB client compatibility.

Enable paper mode:

```bash
# .env
POLYMARKET_ENABLED=true
POLYMARKET_MODE=paper
POLYMARKET_MAX_NOTIONAL_PER_WINDOW=3
POLYMARKET_MAX_EXPOSURE=6
POLYMARKET_NO_NEW_ORDERS_LAST_SEC=30
POLYMARKET_BASE_URL=https://clob.polymarket.com
POLYMARKET_NETWORK=polygon
POLYMARKET_CHAIN_ID=137
```

Run it from CLI:

```bash
node dist/cli.js polymarket ping --paper
node dist/cli.js polymarket scan --btc5m --debug
node dist/cli.js polymarket resolve-event --slug btc-updown-5m-1772556900
node dist/cli.js polymarket book --token-id <tokenId> --live
node dist/cli.js polymarket --btc5m --paper
node dist/cli.js polymarket whoami --live
node dist/cli.js polymarket derive-creds --live
node dist/cli.js polymarket derive-creds --live --print-secrets
node dist/cli.js polymarket lag-summary --minutes 60
node dist/cli.js polymarket ping --live
node dist/cli.js polymarket paper --btc5m --hours 12
node dist/cli.js polymarket --btc5m --live --cancel-all-on-start
```

Required env vars for live mode:
- `POLYMARKET_LIVE_CONFIRMED=true` (required guard for any live Polymarket mode)
- `POLYMARKET_API_KEY` (or your mapped name via `POLYMARKET_API_KEY_ENV`)
- `POLYMARKET_API_SECRET` (or legacy fallback `POLYMARKET_SECRET`)
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_FUNDER`
- `POLYMARKET_CHAIN_ID` (or `POLYMARKET_NETWORK`)
- optional: `POLYMARKET_AUTO_DERIVE_API_KEY=true` to derive API creds from wallet key instead of supplying API key/secret/passphrase directly
- seed discovery mode:
  - `POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m-`
  - `POLYMARKET_SEED_EVENT_SLUGS=btc-updown-5m-1772556900,...`

Connectivity check:
- `node dist/cli.js polymarket ping --paper` checks public CLOB/Gamma reachability.
- `node dist/cli.js polymarket ping --live` additionally validates authenticated `getOpenOrders` access.

Auth wiring notes:
- `POLYMARKET_SIGNATURE_TYPE=0`: EOA signer is the funded account.
- `POLYMARKET_SIGNATURE_TYPE=1` or `2`: Polymarket proxy/funder flow; set `POLYMARKET_FUNDER` to the funded proxy wallet used by your account.
- `node dist/cli.js polymarket whoami --live` prints signer address, signature type, funder, host, chainId, and apiKey prefix (non-secret).
- `node dist/cli.js polymarket derive-creds --live` derives/reuses API creds from the current signer context and stores a local cache in `.polymarket-creds.json`.
- `.polymarket-creds.json` contains secret material; it is gitignored by default.
- combined runtime (`npm run live`) runs RevX and Polymarket in one process when enabled:
  - `POLYMARKET_ENABLED=true POLYMARKET_MODE=paper POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m- npm run live`
  - `POLYMARKET_ENABLED=true POLYMARKET_MODE=live POLYMARKET_LIVE_CONFIRMED=true npm run live`

Extreme-sniping profile (paper 1h, then live micro) with `npm run live` only:

```bash
# 1) Paper validation (1 hour)
POLYMARKET_ENABLED=true \
POLYMARKET_MODE=paper \
POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m- \
POLYMARKET_ENTRY_MAX_REMAINING_SEC=90 \
POLYMARKET_ENTRY_MIN_REMAINING_SEC=20 \
POLYMARKET_PROB_EXTREME=0.90 \
POLYMARKET_EXTREME_HIGH_PRICE=0.97 \
POLYMARKET_EXTREME_LOW_PRICE=0.10 \
POLYMARKET_MIN_NET_EDGE=0.01 \
POLYMARKET_MAX_NOTIONAL_PER_WINDOW=10 \
npm run live

# 2) Live micro sizing (same process entrypoint)
POLYMARKET_ENABLED=true \
POLYMARKET_MODE=live \
POLYMARKET_LIVE_CONFIRMED=true \
POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m- \
POLYMARKET_MAX_NOTIONAL_PER_WINDOW=0.25 \
POLYMARKET_MAX_DAILY_LOSS=2 \
npm run live
```

Decision logs are written as JSONL to:
- `logs/polymarket-decisions.jsonl`
- `logs/polymarket-paper-trades.jsonl`
- `logs/polymarket-lag.jsonl` (calibration instrumentation / lag profiling)

Paper ledger (append-only JSONL):
- `data/polymarket-paper-ledger.jsonl`

Safety notes:
- start with very small sizing
- paper mode first
- live mode safety defaults (when `POLYMARKET_MODE=live` and env override is not provided):
  - `POLYMARKET_MAX_NOTIONAL_PER_WINDOW` capped to `0.25`
  - `POLYMARKET_MAX_DAILY_LOSS` capped to `2`
  - `POLYMARKET_CANCEL_ALL_ON_START=true`
- kill-switch + cancel-all is automatic on severe risk breaches
- `POLYMARKET_KILL_SWITCH=true` runs HOLD-only (no place/cancel mutations)
- no new orders are allowed in the final `POLYMARKET_NO_NEW_ORDERS_LAST_SEC` seconds (default 30s)
- live-mode stale oracle kill threshold: `POLYMARKET_STALE_KILL_AFTER_SEC` (default 60s)
- HTTP call timeout per Polymarket request: `POLYMARKET_HTTP_TIMEOUT_MS`
- paper mode includes non-zero `POLYMARKET_PAPER_SLIPPAGE_BPS` and `POLYMARKET_PAPER_FEE_BPS`
- paper limits: `POLYMARKET_PAPER_MAX_NOTIONAL_PER_WINDOW`, `POLYMARKET_PAPER_MAX_TRADES_PER_HOUR`
- paper entry lifecycle knobs:
  - `POLYMARKET_PAPER_MIN_EDGE` (alias: `POLYMARKET_PAPER_MIN_EDGE_THRESHOLD`)
  - `POLYMARKET_MIN_NET_EDGE`
  - `POLYMARKET_PROB_EXTREME`
  - `POLYMARKET_EXTREME_HIGH_PRICE`
  - `POLYMARKET_EXTREME_LOW_PRICE`
  - `POLYMARKET_ENTRY_MIN_ELAPSED_SEC`
  - `POLYMARKET_ENTRY_MAX_ELAPSED_SEC`
  - `POLYMARKET_ENTRY_MAX_REMAINING_SEC`
  - `POLYMARKET_ENTRY_MIN_REMAINING_SEC`
  - `POLYMARKET_RESOLVE_GRACE_MS`
  - `POLYMARKET_MAX_SPREAD`
- paper position-management knobs:
  - `POLYMARKET_PAPER_STOP_LOSS_EDGE`
  - `POLYMARKET_PAPER_STOP_LOSS_CONSECUTIVE_TICKS`
  - `POLYMARKET_PAPER_TAKE_PROFIT_USD`
  - `POLYMARKET_PAPER_TAKE_PROFIT_DELTA`
- force-trade debug knobs:
  - `POLYMARKET_PAPER_FORCE_TRADE`
  - `POLYMARKET_PAPER_FORCE_INTERVAL_SEC`
  - `POLYMARKET_PAPER_FORCE_NOTIONAL`
  - `POLYMARKET_PAPER_FORCE_SIDE` (`YES` | `NO` | `AUTO`)
- engine emits a high-signal tick log every ~30s even without trades
- oracle routing priority:
  - primary: internal `signalFairMid` from running RevX strategy loop (shared store metrics)
  - secondary: Polymarket oracle estimator (`oracle_proxy`)
- paper mode on stale oracle enters `ORACLE_STALE` state: new entries are blocked, open trades remain pending, and resolution retries continue (no hard halt)
- live mode on stale oracle pauses new entries and keeps retrying/recovery in-loop (transient network errors do not trigger global kill-switch)

Dashboard:
- Main dashboard keeps existing behavior.
- Polymarket paper panel: `http://127.0.0.1:8787/polymarket`
- APIs:
  - `/api/polymarket/summary`
  - `/api/polymarket/trades?limit=200`
  - `/api/polymarket/equity`
  - `/api/status/truth` (canonical in-memory REVX + POLY truth state)
  - `/api/status/health` (venue-call timestamps + recent HTTP/guard errors)

Optional connectivity integration check (no live orders submitted):

```bash
POLYMARKET_INTEGRATION_TEST=true npm run test:polymarket-integration
```

## Runtime Overrides (No Redeploy)

The dashboard now supports runtime overrides (per symbol) with validation and hard clamps.

- UI:
  - open `http://127.0.0.1:8787`
  - go to `Overrides` tab
  - apply a patch, review effective config, or clear overrides
- API:
  - `GET /api/overrides?symbol=BTC-USD`
  - `POST /api/overrides/set`
  - `POST /api/overrides/clear`
  - `POST /api/overrides/reset-defaults` (same as clear)
- Status:
  - `/api/status` includes `overrides` and `effectiveConfig`
  - `/api/status/truth` exposes the canonical TRUTH payload used by runtime logging
  - `/api/status/health` exposes last successful REVX/POLY venue calls and key timestamps
- Audit trail:
  - override changes are emitted as `OVERRIDE` events in recent events

Examples:

```bash
curl -s http://127.0.0.1:8787/api/overrides?symbol=BTC-USD | jq .

curl -s -X POST http://127.0.0.1:8787/api/overrides/set \
  -H 'content-type: application/json' \
  -d '{"symbol":"BTC-USD","patch":{"levelsBuy":1,"levelsSell":1,"baseHalfSpreadBps":10,"allowBuy":true,"allowSell":true,"ttlSeconds":1800},"note":"tighten for low fill period"}'

curl -s -X POST http://127.0.0.1:8787/api/overrides/clear \
  -H 'content-type: application/json' \
  -d '{"symbol":"BTC-USD","note":"back to defaults"}'
```

Runtime path verification:
- `curl -s http://127.0.0.1:8787/api/debug/fs | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/quote | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/signal | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/adverse | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/seed | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/venues | jq .`
- `curl -s http://127.0.0.1:8787/api/news | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/news | jq .`
- `curl -s http://127.0.0.1:8787/api/signals | jq .`
- `curl -s http://127.0.0.1:8787/api/debug/signals | jq .`
- `curl -s "http://127.0.0.1:8787/api/analysis/summary?window=1h" | jq .`
- `curl -s "http://127.0.0.1:8787/api/analysis/fills?window=24h&limit=50" | jq .`
- `curl -s "http://127.0.0.1:8787/api/analysis/fills?window=24h&limit=50&includeInferred=true&symbol=BTC-USD" | jq .`
- `curl -s "http://127.0.0.1:8787/api/analysis/equity_curve?window=24h" | jq .`
- `curl -s http://127.0.0.1:8787/api/adaptive/status | jq .`
- `curl -s "http://127.0.0.1:8787/api/debug/trades?window=24h&limit=50&symbol=BTC-USD&includeInferred=true" | jq .`

### How trades appear in UI when fills endpoints are missing

If RevX fills endpoints are unavailable (404), the reconciler infers fills from balance deltas and records them with `source="inferred"`.
Those inferred fills are persisted into the same performance storage read by `/api/analysis/fills`, so the Performance page trades/fills table still populates.

Use `includeInferred=false` to hide inferred fills temporarily while debugging endpoint behavior.

Operational reference:
- `RUNBOOK.md` (state interpretation + troubleshooting flow)
- `RUNBOOK_NEWS.md` (news-source behavior and posture tuning)
- `RUNBOOK_SIGNALS.md` (signals engine behavior and posture tuning)

## Environment Variables

Core:
- `REVX_API_KEY`
- `REVX_PRIVATE_KEY_BASE64` or `REVX_PRIVATE_KEY_PATH`
- `REVX_BASE_URL` (default `https://revx.revolut.com`)
- `SYMBOL` (default `BTC-USD`)

Logging + observability:
- `LOG_LEVEL=debug|info|warn|error`
- `LOG_MODULES=revx,polymarket,recon,web` (optional module filter)
- `TRUTH_INTERVAL_MS=10000` (canonical TRUTH log interval; transitions emit immediately)
- `DEBUG=1` (show all logs on stdout; default non-event logs stay in `logs/verbose.log`)
- `DEBUG_RECON=1` (show reconcile stage timing logs on stdout)
- `DEBUG_POLY=1` (show verbose polymarket diagnostics on stdout)
- `DEBUG_HTTP=true` (structured per-request HTTP logs + `/api/debug/http-errors`)
- `STRICT_SANITY_CHECK=true` (fail startup if Polymarket sanity probes fail)
- `DISABLE_FILLS_RECONCILE=true` (force disable RevX fills reconciliation)

Polymarket base URLs (hard-separated from RevX):
- `POLY_GAMMA_BASE_URL` (preferred, alias: `POLYMARKET_GAMMA_BASE_URL`)
- `POLY_DATA_BASE_URL` (preferred, alias: `POLYMARKET_DATA_BASE_URL`)
- `POLY_CLOB_BASE_URL` (preferred, alias: `POLYMARKET_CLOB_BASE_URL`)

Capital envelope:
- `CASH_RESERVE_USD=40` (recommended for small accounts)
- `WORKING_CAP_USD=100`

Maker v2 quoting:
- `LEVELS=2` (clamped 1..3)
- `LEVEL_QUOTE_SIZE_USD=8` (min 1)
- `BASE_HALF_SPREAD_BPS=18` (clamped <=80)
- `MIN_HALF_SPREAD_BPS=4`
- `MAX_HALF_SPREAD_BPS=20`
- `CALM_VOL_BPS=15` (recommended for BTC-USD on retail REST cadence)
- `ADAPTIVE_SPREAD=true`
- `ADAPTIVE_STEP_BPS=1`
- `TARGET_FILLS_PER_HOUR=3`
- `TARGET_FILLS_WINDOW_MINUTES=60`
- `FILL_DROUGHT_MINUTES=30`
- `EDGE_LOOKBACK_MINUTES=60`
- `EDGE_GOOD_BPS=8`
- `EDGE_BAD_BPS=0`
- `EDGE_ADJUST_BPS=2`
- `EDGE_MAX_SIDE_ADJUST_BPS=6`
- `TRACK_POSTONLY_REJECTS=true`
- `MAX_CANCELS_PER_HOUR=200`
- `ENABLE_TOPOFBOOK=false`
- `TOB_QUOTE_SIZE_USD=3`
- `TOB_MAX_VOL_BPS=35`
- `TOB_QUOTE_SIZE_USD_NORMAL=3`
- `SEED_MAX_SECONDS=120`
- `SEED_MAX_REPOSTS=10`
- `SEED_TAKER_USD=12`
- `SEED_TAKER_SLIPPAGE_BPS=5`
- `SEED_FORCE_TOB=true`
- `SEED_HALF_SPREAD_BPS=2.5`
- `TOB_MAX_INVENTORY_RATIO_FOR_BOTH=0.25`
- `TOB_MAX_INVENTORY_RATIO_FOR_ONE_SIDED=0.60`
- `SELL_THROTTLE_BELOW_LOWGATE=true`
- `MIN_SELL_LEVELS_BELOW_LOWGATE=1`
- `SELL_DISABLE_BELOW_NOTIONAL_USD=10`
- `LEVEL_STEP_BPS=10`
- `REFRESH_SECONDS=2`
- `REPRICE_MOVE_BPS=10`
- `QUEUE_REFRESH_SECONDS=90`
- `MIN_ORDER_AGE_SECONDS=7`

Signals (influence-only):
- `SIGNALS_ENABLED=true`
- `SIGNAL_REFRESH_MS=1500`
- `SIGNAL_MAX_QUOTE_AGE_MS=4500`
- `SIGNAL_MIN_CONF=0.55`
- `SIGNAL_USDT_DEGRADE=0.03`
- `SIGNAL_VENUES=coinbase,kraken,binance`
- `SIGNAL_MAX_SKEW_BPS=10`
- `SIGNAL_ZSCORE_TO_SKEW=4`
- `SIGNAL_DRIFT_TO_SKEW=0.25`
- `SIGNAL_CALM_TIGHTEN=0.85`
- `SIGNAL_HOT_WIDEN=1.25`
- `SIGNAL_HOT_REGIME_MULTIPLIER=2.5`
- `SIGNAL_TOPOFBOOK_ONLY_IN_CALM=true`
- `SIGNAL_LEVELS_IN_HOT=1`
Signals never place taker orders and only modulate spread width, skew, level count, and TOB micro gating.

News signals:
- `NEWS_ENABLED=true`
- `NEWS_REFRESH_MS=60000`
- `NEWS_MAX_ITEMS=200`
- `NEWS_HALF_LIFE_MS=3600000`
- `NEWS_MIN_CONF=0.60`
- `NEWS_PAUSE_IMPACT=0.85`
- `NEWS_PAUSE_SECONDS=180`
- `NEWS_SPREAD_MULT=0.80`
- `NEWS_SIZE_CUT_MULT=0.60`
- `NEWS_SOURCES_RSS=` (optional comma-separated RSS URL override)
- `NEWS_GDELT_QUERY=` (optional GDELT query override)
- `NEWSAPI_KEY=` (optional; if missing NewsAPI provider is disabled)
News modulates risk posture only: it can widen spreads, cut size, gate one side under inventory stress, or temporarily pause maker quotes during high-confidence shocks.

In-process Signals Engine (same process, no second app):
- `SIGNALS_ENABLED=true` (shared switch with existing signal features)
- `SIGNALS_NEWS_REFRESH_MS=60000`
- `SIGNALS_MACRO_ENABLED=true`
- `SIGNALS_MACRO_REFRESH_MS=300000`
- `SIGNALS_SYSTEM_REFRESH_MS=5000`
- `SIGNALS_MAX_ITEMS=400`
- `SIGNALS_HALF_LIFE_MS=3600000`
- `SIGNALS_MIN_CONF=0.60`
- `SIGNALS_PAUSE_IMPACT=0.90`
- `SIGNALS_PAUSE_SECONDS=180`
- `SIGNALS_SPREAD_MULT=0.80`
- `SIGNALS_SIZE_CUT_MULT=0.60`
- `SIGNALS_RSS_URLS=` (optional override list)
- `SIGNALS_GDELT_QUERY=` (optional override query)
- `SIGNALS_MACRO_URL=` (optional macro feed URL)
- `SIGNALS_LLM_ENABLED=false`
- `OPENAI_API_KEY=` (required only when `SIGNALS_LLM_ENABLED=true`)
Signals endpoints on the same dashboard server:
- `GET /api/signals`
- `GET /api/signals/news`
- `GET /api/signals/macro`
- `GET /api/debug/signals`
- `GET /api/intel/snapshot`
- `GET /api/intel/health`
- `GET /api/intel/commentary`
- `GET /api/intel/debug`

Intel UI routes:
- `GET /` (trading cockpit, unchanged)
- `GET /intel` (WorldMonitor-style Intel Console, 3-column)
- `GET /?view=intel` (alias to Intel Console)

Intel Console middle chart guide:
- `Fair Price`: `signalFairMid` blended from cross-venue data.
- `Global Mid`: robust cross-venue reference before RevX blending.
- `RevX Mid`: current venue mid.
- `Basis (bps)`: `(RevX - Fair) / Fair * 10,000` — large absolute values mean local dislocation.
- `Dispersion (bps)`: cross-venue disagreement — rising dispersion means weaker price consensus.
- `Confidence`: signal trust score from freshness + source agreement.
- Threshold bands: `OK / WARN / RISK` bands are drawn from effective fair-price dispersion thresholds.
- Current Action line maps posture to quoting behavior:
  - `NORMAL`: baseline quoting.
  - `CAUTION`: modest widen + size throttle.
  - `RISK_OFF`: stronger widen + size throttle + TOB reduction.
  - `HALT`: soft de-risk by default; hard block only when intel trade guard is explicitly enabled.

Elite Intel + Fair Price + Adverse (in-process, optional):
- `ENABLE_INTEL=true`
- `ENABLE_INTEL_TRADE_GUARD=false` (default soft-only; does not hard-stop quoting)
- `INTEL_MAX_ACTION=soften` (`soften|halt`)
- `INTEL_CROSSVENUE_ACTION=soften` (`soften|ignore|halt`)
- `INTEL_PROVIDER_DEGRADED_ACTION=ignore` (`ignore|soften|halt`)
- `INTEL_FAST_POLL_SECONDS=10`
- `INTEL_SLOW_POLL_SECONDS=60`
- `INTEL_MAX_ITEMS=500`
- `INTEL_DEDUPE_WINDOW_MIN=180`
- `INTEL_DEDUPE_WINDOW_SECONDS=180`
- `INTEL_EVENT_COOLDOWN_SECONDS=30`
- `INTEL_MAX_HIGH_IMPACT_PER_MINUTE=2`
- `ENABLE_FAIR_PRICE=true`
- `FAIR_PRICE_MIN_VENUES=2`
- `FAIR_PRICE_MAX_STALE_MS=15000`
- `FAIR_PRICE_USDT_PENALTY_BPS=1.5`
- `ENABLE_ADVERSE=true`
- `INTEL_MAX_WIDEN_BPS=10`
- `INTEL_MAX_SIZE_CUT=0.7`
- `INTEL_MAX_SKEW_BPS=12`
- `INTEL_HALT_IMPACT=0.95`
- `INTEL_HALT_SECONDS=90`
- `INTEL_DECAY_MINUTES=30`
- `ENABLE_GDELT=true`
- `ENABLE_RSS=true`
- `ENABLE_CRYPTOPANIC=false`
- `ENABLE_NEWSAPI=false`
- `ENABLE_X=false`
- `GDELT_QUERY=...`
- `GDELT_MAX_ARTICLES=25`
- `RSS_URLS=...`
- `X_BEARER_TOKEN=`
- `X_QUERY=...`
- `X_MAX_RESULTS_PER_POLL=10`
- `UI_SHOW_DIAGNOSTICS_DRAWER=true`
- `UI_DIAGNOSTICS_DEFAULT_OPEN=false`
- `UI_HEADER_MAX_ROWS=2`

Intel posture decisioning (production safety):
- Provider degradation never triggers HALT by itself; provider errors reduce confidence and stay in diagnostics.
- Cross-venue dispersion spikes default to DE-RISK/soften, not hard HALT.
- HALT requires either:
1. High-impact intel cluster confirmed by >=2 independent providers.
2. News + market anomaly alignment.
- Otherwise posture prefers `DE-RISK` (spread widen + size throttle + optional TOB off), with hysteresis and cooldown to avoid flip-flopping.

Cross-venue fair-price signals (analytics/fair-mid only):
- `ENABLE_CROSS_VENUE_SIGNALS=true`
- `VENUE_REFRESH_MS=1000`
- `VENUE_STALE_MS=5000`
- `VENUE_TIMEOUT_MS=1200`
- `VENUE_MAX_BACKOFF_MS=30000`
- `FAIR_DRIFT_MAX_BPS=8`
- `FAIR_BASIS_MAX_BPS=10`
- `FAIR_STALE_MS=2500`
- `FAIR_MIN_VENUES=3`
- `FAIR_MAX_DISPERSION_BPS=10`
- `FAIR_MAX_BASIS_BPS=12`
- `TOXIC_DRIFT_BPS=12`
- `HOT_VOL_BPS=35`
- `VENUE_WEIGHTS_JSON={"coinbase":1.0,"binance":1.0,"kraken":0.8}`
These inputs do not place taker orders or force trades by themselves; they feed analytics + fair-mid telemetry.

Spread control:
- `MIN_INSIDE_SPREAD_BPS=0.5`
- `MIN_VOL_MOVE_BPS_TO_QUOTE=0`
- `VOL_PROTECT_MODE=widen` (`widen` or `block`)
- `VOL_WIDEN_MULT_MIN=1.25`
- `VOL_WIDEN_MULT_MAX=1.75`
- `VOL_WINDOW_SECONDS=60`
- `VOL_PAUSE_BPS=70`
- `VOL_SPREAD_MULT_MIN=1.0`
- `VOL_SPREAD_MULT_MAX=2.2`
- `MAKER_FEE_BPS=0`
- `TAKER_FEE_BPS=9`
- `FEES_MAKER_BPS=1.0` (legacy alias; `MAKER_FEE_BPS` wins)
- `FEES_TAKER_BPS=4.0` (legacy alias; `TAKER_FEE_BPS` wins)
- `MIN_REALIZED_EDGE_BPS=4`
- `MIN_TAKER_EDGE_BPS=14`
- `EDGE_SAFETY_BPS=1.2`
- `ENABLE_ADVERSE_SELECTION_LOOP=true`
- `ADVERSE_ENABLED=true`
- `ADVERSE_MARKOUT_WINDOWS_MS=5000,15000,60000`
- `ADVERSE_TOXIC_MARKOUT_BPS=-4`
- `ADVERSE_MIN_FILLS=3`
- `ADVERSE_DECAY=0.90`
- `ADVERSE_STATE_THRESHOLDS=0.35,0.55,0.75,0.90`
- `ADVERSE_MAX_SPREAD_MULT=2.25`
- `AS_HORIZON_SECONDS=10`
- `AS_SAMPLE_FILLS=60`
- `AS_BAD_AVG_BPS=4`
- `AS_BAD_RATE=0.55`
- `AS_BAD_FILL_BPS=-6`
- `AS_WIDEN_STEP_BPS=2`
- `AS_MAX_WIDEN_BPS=10`
- `AS_DISABLE_TOB_ON_TOXIC=true`
- `AS_COOLDOWN_SECONDS=120`
- `AS_REDUCE_LEVELS_ON_TOXIC=true`
- `AS_LEVELS_FLOOR=1`
- `AS_DECAY_BPS_PER_MIN=1`
- `SEED_ENABLED=true`
- `ENABLE_TAKER_SEED=false`
- `SEED_TAKER_MAX_USD=15`
- `SEED_TAKER_MAX_SLIPPAGE_BPS=6`
- `HEDGE_ENABLED=true`
- `HEDGE_MAX_USD_PER_MIN=30`
- `HEDGE_MAX_SLIPPAGE_BPS=8`
- `HEDGE_ONLY_WHEN_CONFIDENT=true`
Inside spread is not the main profit source for this maker strategy.
The bot quotes wider (`BASE_HALF_SPREAD_BPS`) and needs enough movement to realize edge.

Trend toxicity guard:
- `TREND_WINDOW_SECONDS=15`
- `TREND_PAUSE_BPS=20`
- `TREND_SKEW_BPS=10`
- `TREND_PROTECTION_MODE=spread` (`spread` or `reduce_level`)

Inventory skew:
- `DYNAMIC_TARGET_BTC=true` (default; target is 50% of current equity)
- `DYNAMIC_TARGET_BUFFER_USD=40` (dynamic max target buffer)
- `TARGET_BTC_NOTIONAL_USD=80`
- `MAX_BTC_NOTIONAL_USD=120`
- `SKEW_MAX_BPS=25` (clamped <=50)
- `MIN_QUOTE_SIZE_USD=3`

Risk / safety:
- `MAX_CONSECUTIVE_ERRORS=3`
- `PAUSE_SECONDS_ON_VOL=300`
- `MAX_ACTIVE_ORDERS=10`
- `CANCEL_RETRY=2`
- `PLACE_RETRY=2`
- `MAX_ACTIONS_PER_LOOP=4`
- `PNL_DAILY_STOP_USD=-5`

Metrics/runtime:
- `METRICS_LOG_EVERY_SECONDS=30`
- `RECONCILE_SECONDS=5`
- `REQUESTS_PER_MINUTE=800`
- `STORE_BACKEND=json` (default; `sqlite` requires `better-sqlite3`)
- `DEBUG_BALANCES=false` (when true, logs one-time raw balance field diagnostics)
- `DB_PATH=./revx-bot.sqlite`
- `DRY_RUN=true`
- `DASHBOARD_ENABLED=true`
- `DASHBOARD_PORT=8787`
- `MAX_UI_EVENTS=500` (dashboard event buffer and `/api/status?limit=` default)
- `MAX_SIGNAL_POINTS=2000` (bounded signal/external snapshot history in store)
- `MAX_EQUITY_POINTS=5000` (in-memory ring buffer for equity chart points)
- `EQUITY_SAMPLE_MS=2000` (equity series bucket/dedupe interval in ms)
- `PERSIST_EQUITY_SERIES=false` (persist equity series to localStorage between refreshes)
- `MAX_API_EVENTS=500` (backend default event limit)
- `EVENT_DEDUPE=true`
- `ENV_FILE_PATH=.env` (optional env duplicate-key diagnostics)

## Equity Tracking & Chart

The dashboard computes equity client-side from each poll using latest balances + ticker mid:
- `equityUsd = usd_total + btc_total * mid`
- `equityBtc = btc_total + usd_total / mid`
- `btcNotionalUsd = btc_total * mid`
- `usdNotionalBtc = usd_total / mid`

It stores an in-memory bounded equity series (default `MAX_EQUITY_POINTS=5000`), deduped to one point per ~2-second bucket, and renders:
- equity chart with `USD | BTC` toggle
- equity window filters: `24H | 12H | 4H | 1H | 15M`
- tooltip with timestamp, equity, mid, USD total, BTC total
- composition chart (USD total vs BTC notional in USD)
- drawdown chart with `Abs | %` mode and max drawdown summary
- reset button to clear equity history (`Reset series`)

Storage backend notes:
- `STORE_BACKEND=json`: always uses JSON store.
- `STORE_BACKEND=sqlite`: requires `better-sqlite3`. If missing, bot exits with:
  `Install: npm i better-sqlite3`

## MakerStrategy v2 Behavior

Each loop:
1. Reconcile first (balances + active orders + fills).
2. Read ticker and mid.
3. Build a quote plan (buy/sell levels + TOB mode + blocked reasons) and persist it in `botStatus.quoting`.
4. Apply low-movement protection using `VOL_PROTECT_MODE`:
   `block` disables quoting; `widen` keeps quoting and widens half-spread.
5. Compute volatility move in `VOL_WINDOW_SECONDS`.
6. Pause if move exceeds `VOL_PAUSE_BPS`.
7. Compute spread multiplier within `[VOL_SPREAD_MULT_MIN, VOL_SPREAD_MULT_MAX]`.
8. Apply adaptive half-spread within `[MIN_HALF_SPREAD_BPS, MAX_HALF_SPREAD_BPS]` using recent fill rate and calm-vol checks.
9. Compute inventory ratio from reconciled BTC notional vs dynamic or fixed target.
10. Apply inventory skew (`SKEW_MAX_BPS`) and trend toxicity guard.
11. Build side-aware multi-level quotes (`LEVELS`) with post-only-safe rounding.
12. Manage cancel/replace/queue-refresh with minimum order age.
13. Respect per-loop action budget (`MAX_ACTIONS_PER_LOOP`).

Notes:
- Orders are always limit + post_only.
- `client_order_id` remains UUID for API compatibility.
- Bot identity is tracked via local `bot_tag` (e.g. `bot-<runid>-BTC-USD-BUY-L0`).

## Reconciliation, Store, Metrics

Reconciler (every ~5s):
- syncs active orders and statuses
- ingests fills
- ingests balances
- publishes latest strategy state (`usd_free`, `btc_free`, active orders by tag)

Store includes:
- `orders`, `order_history`, `fills`, `balances`, `ticker_snapshots`
- `strategy_decisions`
- `metrics` (`realized_pnl_usd`, `avg_edge_bps_buy`, `avg_edge_bps_sell`, `fills_1h_count`, `cancels_1h_count`)
- fill edge fields: `fills.mid_at_fill`, `fills.edge_bps`

## How To Make It Profitable

1. Start with `DRY_RUN=true`.
2. Go live with `LEVEL_QUOTE_SIZE_USD=5..8` and `LEVELS=1..2`.
3. Watch:
- maker fills per hour
- inventory drift vs `TARGET_BTC_NOTIONAL_USD`
- realized PnL metric
- volatility pause frequency
4. Tune rules of thumb:
- no fills: tighten `BASE_HALF_SPREAD_BPS` (down toward 8)
- too many fills + inventory drift: increase `SKEW_MAX_BPS`, reduce size, or widen spread
- volatility losses: increase pause sensitivity or widen spread multiplier bounds

## How To Tune

- If `fills_1h == 0` and avg edge bps is positive, tighten `BASE_HALF_SPREAD_BPS` by `2..3` bps.
- If avg edge bps is negative, widen `BASE_HALF_SPREAD_BPS` by `5..10` bps.
- If edge is negative during trends, increase `TREND_SKEW_BPS` or switch `TREND_PROTECTION_MODE=reduce_level`.
- If buys are blocked by reserve, lower `CASH_RESERVE_USD` or `LEVEL_QUOTE_SIZE_USD`.
- TOB regime behavior:
  calm (`volMoveBps <= CALM_VOL_BPS`) -> TOB on with `TOB_QUOTE_SIZE_USD`
  normal (`CALM_VOL_BPS < volMoveBps <= TOB_MAX_VOL_BPS`) -> TOB on with `TOB_QUOTE_SIZE_USD_NORMAL`
  hot (`volMoveBps > TOB_MAX_VOL_BPS`) -> TOB off
- TOB inventory behavior:
  `|inventoryRatio| <= TOB_MAX_INVENTORY_RATIO_FOR_BOTH` -> TOB both sides
  BTC-light (`inventoryRatio` below negative threshold) -> TOB buy-only
  BTC-heavy (`inventoryRatio` above positive threshold) -> TOB sell-only
  extreme imbalance (`|inventoryRatio| > TOB_MAX_INVENTORY_RATIO_FOR_ONE_SIDED`) -> wrong-side normal levels reduced

## Profitability Tuning Loop

1. Run `simulate --minutes 5` in dry run and inspect adaptive reasons per cycle.
2. Watch `Execution Health` for `post-only rejects`, `cancels 1h`, and `avg resting time`.
3. If `fills_last_30m = 0`, adaptive controller tightens spread within min clamp.
4. If edge turns negative or churn is high, adaptive controller widens spread.
5. Use `Adaptive Controller` card + `Signals` card together before manual parameter changes.

## Roadmap

- Milestone 1: stable post-only maker + safety controls.
- Milestone 2: adaptive spread + edge-weighted quoting + bounded events + execution health.
- Milestone 3: multi-symbol scheduling, replay/backtesting, alerting and scale metrics.

## REST / Rate Limit Discipline

- Ticker polling every 2s (no order book spam).
- Reconciler every 5s.
- Cancel/replace bounded by `MAX_ACTIONS_PER_LOOP`.
- API request scheduler + retry backoff is used for 429/5xx paths.

## Signature Construction (Critical)

Signed payload string:

```text
timestamp + HTTP_METHOD + path + query_string + minified_json_body
```

No separators.

Headers:
- `X-Revx-API-Key`
- `X-Revx-Timestamp`
- `X-Revx-Signature`

## Smoke Test Checklist

1. `DRY_RUN=true`: dashboard/CLI shows changing target quotes.
2. `DRY_RUN=false`: 2–4 active bot orders appear.
3. Move in mid: orders reprice and tags/levels remain consistent.
4. Sharp move > `VOL_PAUSE_BPS`: bot cancels and pauses for `PAUSE_SECONDS_ON_VOL`.
