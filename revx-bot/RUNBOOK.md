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
