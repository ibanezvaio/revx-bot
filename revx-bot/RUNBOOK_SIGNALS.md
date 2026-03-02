# Signals Engine Runbook

## What It Is
The Signals Engine runs inside the same `revx-bot` Node process and dashboard server.
It aggregates:
- market-moving news (RSS + GDELT)
- optional macro events
- internal system risk signals (reject spikes, churn, fill drought, dispersion spikes)

It outputs:
- per-item signal feed
- aggregate state (`NORMAL | CAUTION | RISK_OFF | RISK_ON | PAUSE`)
- posture reasons used by the quote planner

## Endpoints (same dashboard port)
- `GET /api/signals`
- `GET /api/signals/news`
- `GET /api/signals/macro`
- `GET /api/debug/signals`
- `GET /api/intel/snapshot`
- `GET /api/intel/health`

`/api/status` includes compact summary under `signals` and diagnostics under `diagnostics.signals`.
`/api/status` also includes `intelSnapshot`, `intelHealth`, `fairPrice`, and `adverse`.

## Config
- `SIGNALS_ENABLED=true`
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
- `SIGNALS_RSS_URLS=`
- `SIGNALS_GDELT_QUERY=`
- `SIGNALS_MACRO_URL=`
- `SIGNALS_LLM_ENABLED=false`
- `OPENAI_API_KEY=`

## Strategy Effects
Signals are risk posture controls, not directional betting:
- `PAUSE`: disables new maker quoting for cooldown window
- `RISK_OFF`: widen spread, cut size, may gate buys if already BTC-heavy
- `RISK_ON`: widen spread, cut size, may gate sells if already BTC-light
- `CAUTION`: modest widen + size cut
- `NORMAL`: no extra signal penalty

No taker execution is triggered purely by signals.

## Health and Failure Behavior
- Provider failures do not crash the bot.
- Health is exposed in `/api/debug/signals` and `/api/status` diagnostics.
- If all providers fail, existing snapshot is retained and health marks degraded.
- Optional LLM enrichment auto-suspends for 10 minutes on error.

## Verification
1. Start bot normally (`npm run dev`).
2. Check snapshot:
   - `curl -s http://127.0.0.1:8787/api/signals | jq`
3. Check debug health:
   - `curl -s http://127.0.0.1:8787/api/debug/signals | jq`
4. Check status summary:
   - `curl -s http://127.0.0.1:8787/api/status | jq '.signals'`
5. Confirm dashboard left sidebar updates the Signals feed and aggregate banner.
