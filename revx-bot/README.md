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
3. Keep `KILL_SWITCH_FILE` enabled.
4. Confirm signatures and endpoint behavior before live trading.
5. Move to live only after observing stable dry-run behavior.

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
- `Cancel All`, `Pause/Resume`, `Kill Switch`
- keyboard shortcuts: `C` (cancel-all confirm), `P` (pause/resume), `Esc` (close modal)

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
node dist/cli.js tune            # print spread tuning suggestion from last hour
node dist/cli.js tune --apply    # apply BASE_HALF_SPREAD_BPS suggestion to .env
npm run test:cancel-idempotency  # simulate 409 cancel response and verify idempotent handling
npm run test:adaptive-events     # adaptive clamp + side cap + event ring buffer checks
```

## Environment Variables

Core:
- `REVX_API_KEY`
- `REVX_PRIVATE_KEY_BASE64` or `REVX_PRIVATE_KEY_PATH`
- `REVX_BASE_URL` (default `https://revx.revolut.com`)
- `SYMBOL` (default `BTC-USD`)

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
- `SIGNAL_MAX_SKEW_BPS=10`
- `SIGNAL_ZSCORE_TO_SKEW=4`
- `SIGNAL_DRIFT_TO_SKEW=0.25`
- `SIGNAL_CALM_TIGHTEN=0.85`
- `SIGNAL_HOT_WIDEN=1.25`
- `SIGNAL_HOT_REGIME_MULTIPLIER=2.5`
- `SIGNAL_TOPOFBOOK_ONLY_IN_CALM=true`
- `SIGNAL_LEVELS_IN_HOT=1`
Signals never place taker orders and only modulate spread width, skew, level count, and TOB micro gating.

Spread control:
- `MIN_INSIDE_SPREAD_BPS=0.5`
- `MIN_VOL_MOVE_BPS_TO_QUOTE=5`
- `VOL_WINDOW_SECONDS=60`
- `VOL_PAUSE_BPS=70`
- `VOL_SPREAD_MULT_MIN=1.0`
- `VOL_SPREAD_MULT_MAX=2.2`
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
- `KILL_SWITCH_FILE=./KILL`
- `PAUSE_SWITCH_FILE=./PAUSE`
- `DASHBOARD_ENABLED=true`
- `DASHBOARD_PORT=8787`
- `MAX_UI_EVENTS=500` (dashboard event buffer and `/api/status?limit=` default)
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
3. Skip/cancel quoting only when both conditions are true:
inside spread below `MIN_INSIDE_SPREAD_BPS` and movement below `MIN_VOL_MOVE_BPS_TO_QUOTE`.
4. Compute volatility move in `VOL_WINDOW_SECONDS`.
5. Pause if move exceeds `VOL_PAUSE_BPS`.
6. Compute spread multiplier within `[VOL_SPREAD_MULT_MIN, VOL_SPREAD_MULT_MAX]`.
7. Apply adaptive half-spread within `[MIN_HALF_SPREAD_BPS, MAX_HALF_SPREAD_BPS]` using recent fill rate and calm-vol checks.
8. Compute inventory ratio from reconciled BTC notional vs dynamic or fixed target.
9. Apply inventory skew (`SKEW_MAX_BPS`) and trend toxicity guard.
10. Build side-aware multi-level quotes (`LEVELS`) with post-only-safe rounding.
11. Manage cancel/replace/queue-refresh with minimum order age.
12. Respect per-loop action budget (`MAX_ACTIONS_PER_LOOP`).

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
4. Create `./KILL`: bot cancels bot orders and exits.
5. Sharp move > `VOL_PAUSE_BPS`: bot cancels and pauses for `PAUSE_SECONDS_ON_VOL`.
