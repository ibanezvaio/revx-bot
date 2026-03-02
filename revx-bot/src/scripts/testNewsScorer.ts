import { scoreHeadline } from "../news/NewsScorer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const etf = scoreHeadline({
    ts: Date.now(),
    title: "Spot ETF approval sends Bitcoin higher",
    source: "Reuters",
    url: "https://example.test/etf"
  });
  assert(etf.direction === "UP", `expected ETF headline to be UP, got ${etf.direction}`);
  assert(etf.impact >= 0.7, `expected ETF impact >= 0.7, got ${etf.impact}`);
  assert(etf.category === "crypto", `expected ETF category crypto, got ${etf.category}`);

  const strike = scoreHeadline({
    ts: Date.now(),
    title: "Missile strike raises war fears across region",
    source: "Reuters",
    url: "https://example.test/strike"
  });
  assert(strike.direction === "DOWN", `expected strike headline to be DOWN, got ${strike.direction}`);
  assert(strike.impact >= 0.75, `expected strike impact >= 0.75, got ${strike.impact}`);
  assert(strike.category === "war", `expected strike category war, got ${strike.category}`);

  const rateCut = scoreHeadline({
    ts: Date.now(),
    title: "Central bank announces surprise rate cut decision",
    source: "Bloomberg",
    url: "https://example.test/rates"
  });
  assert(rateCut.direction === "UP", `expected rate-cut headline to be UP, got ${rateCut.direction}`);
  assert(rateCut.category === "rates", `expected rate-cut category rates, got ${rateCut.category}`);

  // eslint-disable-next-line no-console
  console.log("NewsScorer tests: PASS");
}

run();
