export type VenueId = "coinbase" | "binance" | "kraken";

export type VolRegime = "calm" | "normal" | "hot";

export type ExternalVenueSnapshot = {
  symbol: string;
  venue: VenueId;
  quote: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread_bps: number | null;
  latency_ms: number;
  ok: boolean;
  error?: string;
};

export type VenueHealth = {
  venue: VenueId;
  weight: number;
  ok: boolean;
  stale: boolean;
  age_ms: number;
  mid: number | null;
  spread_bps: number | null;
  latency_ms: number;
  error?: string;
};

export type SignalSnapshot = {
  symbol: string;
  ts: number;
  revx_mid: number;
  global_mid: number;
  fair_mid: number;
  basis_bps: number;
  drift_bps: number;
  stdev_bps: number;
  z_score: number;
  confidence: number;
  dispersion_bps: number;
  vol_regime: VolRegime;
  drift_component_bps: number;
  basis_correction_bps: number;
  healthy_venues: number;
  total_venues: number;
  reason?: string;
};

export type CrossVenueComputation = {
  signal: SignalSnapshot;
  venues: VenueHealth[];
  rawSnapshots: ExternalVenueSnapshot[];
};
