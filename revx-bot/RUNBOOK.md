# Elite Autopilot Runbook

## Quick start

1. Build and run:
```bash
npm run build
npm run dev
```
2. Validate status/debug payloads:
```bash
curl -s http://127.0.0.1:8787/api/status | jq '{signal:.analytics.signalRegime, bias:.analytics.signalBias, fairMid:.analytics.signalFairMid, adverse:.analytics.adverseSelectionState}'
curl -s http://127.0.0.1:8787/api/debug/signal | jq .
curl -s http://127.0.0.1:8787/api/debug/adverse | jq .
curl -s http://127.0.0.1:8787/api/debug/seed | jq .
curl -s http://127.0.0.1:8787/api/debug/venues | jq .
```

## Core states

- Signal regime:
  - `CALM`: normal two-sided quoting, tighter spreads allowed.
  - `TREND`: directional drift detected; skew adjusts with confidence.
  - `VOLATILE`: defensive widening and possible level reduction.
  - `CRISIS`: high dispersion/venue failure; makers can pause and hedge path can activate.
- Adverse loop state:
  - `NORMAL`: no extra defense.
  - `WIDEN`: spread multiplier applied.
  - `REDUCE`: levels reduced.
  - `PAUSE`: maker quoting paused.
  - `HEDGE`: maker pause + bounded taker hedge allowed (if configured).
- Seed mode:
  - `SEED_BUY`: buy-only maker seeding until low BTC gate.
  - `TWO_SIDED`: normal operation.
  - `REBALANCE`: sell-heavy reduction of excess BTC notional.

## “Why not trading?” checklist

1. Inspect `botStatus.quoting.quoteBlockedReasons` from `/api/status`.
2. Check `/api/debug/quote` for `quotePlan` and `inputs`.
3. Check `/api/debug/adverse` for `state`, `toxicityScore`, and reasons.
4. Check `/api/debug/seed` for seed state and repost/taker progress.
5. Check `/api/debug/venues` for stale/error venues and confidence impact.

## Key env knobs

- Signal:
  - `SIGNALS_ENABLED`, `SIGNAL_REFRESH_MS`, `SIGNAL_MAX_QUOTE_AGE_MS`, `SIGNAL_MIN_CONF`, `SIGNAL_VENUES`.
- Fair/toxicity:
  - `FAIR_MAX_DISPERSION_BPS`, `FAIR_MAX_BASIS_BPS`, `TOXIC_DRIFT_BPS`.
- Adverse:
  - `ADVERSE_ENABLED`, `ADVERSE_MARKOUT_WINDOWS_MS`, `ADVERSE_TOXIC_MARKOUT_BPS`, `ADVERSE_STATE_THRESHOLDS`, `ADVERSE_MAX_SPREAD_MULT`.
- Fees:
  - `MAKER_FEE_BPS`, `TAKER_FEE_BPS`, `MIN_TAKER_EDGE_BPS`, `EDGE_SAFETY_BPS`.
- Seeding / hedge:
  - `SEED_ENABLED`, `ENABLE_TAKER_SEED`, `SEED_TAKER_MAX_USD`, `SEED_TAKER_MAX_SLIPPAGE_BPS`,
  - `HEDGE_ENABLED`, `HEDGE_MAX_USD_PER_MIN`, `HEDGE_MAX_SLIPPAGE_BPS`, `HEDGE_ONLY_WHEN_CONFIDENT`.

## Safety notes

- Post-only maker behavior is default.
- Taker actions are bounded by edge and slippage guardrails.
- Kill switch and runtime pause remain authoritative.

## Polymarket module notes

Runtime: Node `>=20.10` is recommended for `@polymarket/clob-client`.

Paper-mode first:

```bash
node dist/cli.js polymarket ping --paper
node dist/cli.js polymarket resolve-event --slug btc-updown-5m-1772556900
node dist/cli.js polymarket book --token-id <tokenUpId> --live
node dist/cli.js polymarket --btc5m --paper
node dist/cli.js polymarket paper --btc5m --hours 12
node dist/cli.js polymarket paper --btc5m --hours 0.2 --force-trade --force-interval-sec 60 --force-notional 1
POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m- POLYMARKET_PAPER_FORCE_TRADE=true node dist/cli.js polymarket paper --btc5m --hours 8
```

Live-mode prerequisites:
- set `POLYMARKET_ENABLED=true`
- set `POLYMARKET_MODE=live`
- set `POLYMARKET_LIVE_CONFIRMED=true` (hard guard; required)
- set `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET` (or `POLYMARKET_SECRET`), `POLYMARKET_PASSPHRASE`
- set `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_FUNDER`
- set `POLYMARKET_CHAIN_ID` (or `POLYMARKET_NETWORK`)
- set `POLYMARKET_SIGNATURE_TYPE` correctly:
  - `0` for direct EOA-funded flow
  - `1` or `2` for Polymarket proxy/funder flow (most polymarket.com accounts)
- verify connectivity with `node dist/cli.js polymarket ping --live`
- verify signer/funder wiring with `node dist/cli.js polymarket whoami --live`
- derive/reuse API creds with `node dist/cli.js polymarket derive-creds --live`
- run live session with startup cancel-all:
  - `node dist/cli.js polymarket --btc5m --live --cancel-all-on-start`
- run combined RevX + Polymarket in one process:
  - `POLYMARKET_ENABLED=true POLYMARKET_MODE=paper POLYMARKET_SEED_SERIES_PREFIX=btc-updown-5m- npm run live`
  - `POLYMARKET_ENABLED=true POLYMARKET_MODE=live POLYMARKET_LIVE_CONFIRMED=true npm run live`
- optional API-only integration harness (no orders):
  - `POLYMARKET_INTEGRATION_TEST=true npm run test:polymarket-integration`

Safety defaults:
- live mode enforced defaults when env override is not provided:
  - `POLYMARKET_MAX_NOTIONAL_PER_WINDOW <= 0.25`
  - `POLYMARKET_MAX_DAILY_LOSS <= 2`
  - `POLYMARKET_CANCEL_ALL_ON_START=true`
- small `POLYMARKET_MAX_NOTIONAL_PER_WINDOW`
- hard `POLYMARKET_MAX_EXPOSURE`
- `POLYMARKET_NO_NEW_ORDERS_LAST_SEC=30`
- `POLYMARKET_STALE_KILL_AFTER_SEC=60` (live mode only; transient stale ticks do not hard-kill before this)
- `POLYMARKET_HTTP_TIMEOUT_MS=8000` for per-call network timeout
- engine kill-switch triggers cancel-all on critical breaches
- `POLYMARKET_KILL_SWITCH=false` forces HOLD-only operation (no place/cancel mutations)
- paper fills include `POLYMARKET_PAPER_SLIPPAGE_BPS` and `POLYMARKET_PAPER_FEE_BPS`
- overnight guardrails:
  - `POLYMARKET_PAPER_MAX_NOTIONAL_PER_WINDOW`
  - `POLYMARKET_PAPER_MAX_TRADES_PER_HOUR`
- paper lifecycle tuning:
  - `POLYMARKET_PAPER_MIN_EDGE` (alias: `POLYMARKET_PAPER_MIN_EDGE_THRESHOLD`)
  - `POLYMARKET_ENTRY_MIN_ELAPSED_SEC`
  - `POLYMARKET_ENTRY_MAX_ELAPSED_SEC`
  - `POLYMARKET_ENTRY_MIN_REMAINING_SEC`
  - `POLYMARKET_RESOLVE_GRACE_MS`
  - `POLYMARKET_MAX_SPREAD`
- paper position-management:
  - `POLYMARKET_PAPER_STOP_LOSS_EDGE`
  - `POLYMARKET_PAPER_STOP_LOSS_CONSECUTIVE_TICKS`
  - `POLYMARKET_PAPER_TAKE_PROFIT_USD`
  - `POLYMARKET_PAPER_TAKE_PROFIT_DELTA`
- force-trade debug knobs:
  - `POLYMARKET_PAPER_FORCE_TRADE`
  - `POLYMARKET_PAPER_FORCE_INTERVAL_SEC`
  - `POLYMARKET_PAPER_FORCE_NOTIONAL`
  - `POLYMARKET_PAPER_FORCE_SIDE`
- seed discovery knobs:
  - `POLYMARKET_SEED_SERIES_PREFIX` (example: `btc-updown-5m-`)
  - `POLYMARKET_SEED_EVENT_SLUGS` (comma-separated explicit windows)
- engine writes a high-signal tick log every ~30s, including edge/threshold/action even when no fills occur
- oracle source hierarchy:
  - primary: `signalFairMid` from RevX runtime metrics
  - secondary: `oracle_proxy` estimator fallback
- stale oracle behavior:
  - paper: `ORACLE_STALE` state blocks new entries, keeps retrying refresh and pending resolutions
  - live: triggers kill-switch and cancel-all with last oracle diagnostics

Decision analysis:
- review `logs/polymarket-decisions.jsonl`
- review `logs/polymarket-paper-trades.jsonl`
- ledger file: `data/polymarket-paper-ledger.jsonl`
- dashboard paper panel: `http://127.0.0.1:8787/polymarket`
