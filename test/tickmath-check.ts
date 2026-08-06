// Offline checks for the concentrated-liquidity math in src/tickMath.ts.
// No network and no API key needed:
//
//   npx esbuild test/tickmath-check.ts --bundle --format=esm --platform=node \
//     --target=node20 --outfile=test/tickmath-check.bundle.mjs
//   node test/tickmath-check.bundle.mjs
import {
  amountsForLiquidity,
  feeGrowthInside,
  feesAccrued,
  getSqrtRatioAtTick,
  subMod256,
  MAX_TICK,
  MIN_TICK,
  Q96,
} from '../src/tickMath.js';

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${got}, want ${want}`}`);
}

function assert(name: string, cond: boolean) {
  check(name, cond, true);
}

// --- TickMath against Uniswap V3's published constants ---------------------
// MIN_SQRT_RATIO and MAX_SQRT_RATIO are exact; reproducing them means every
// entry of the bit-decomposition constant table is correct.
check('getSqrtRatioAtTick(0) === 2^96', getSqrtRatioAtTick(0), Q96);
check('MIN_SQRT_RATIO', getSqrtRatioAtTick(MIN_TICK), 4295128739n);
check(
  'MAX_SQRT_RATIO',
  getSqrtRatioAtTick(MAX_TICK),
  1461446703485210103287273052203988822378723970342n,
);
check('getSqrtRatioAtTick(1)', getSqrtRatioAtTick(1), 79232123823359799118286999568n);
check('getSqrtRatioAtTick(-1)', getSqrtRatioAtTick(-1), 79224201403219477170569942574n);

// Everything in between is checked against sqrt(1.0001^tick) * 2^96 computed
// in floating point. Math.pow drifts by a few parts in 1e12 at the extreme
// ticks, so the tolerance is loose — it is here to catch a wrong constant in
// the table (which would be off by orders of magnitude), not to out-precise
// the exact bigint result.
const FLOAT_TOLERANCE = 1e-9;
let worstError = 0;
for (let tick = -800000; tick <= 800000; tick += 3313) {
  const got = Number(getSqrtRatioAtTick(tick));
  const want = Math.pow(1.0001, tick / 2) * 2 ** 96;
  worstError = Math.max(worstError, Math.abs(got - want) / want);
}
assert(
  `float agreement across tick range (worst relative error ${worstError.toExponential(2)})`,
  worstError < FLOAT_TOLERANCE,
);

let monotonic = true;
let prev = getSqrtRatioAtTick(MIN_TICK);
for (let tick = MIN_TICK + 1; tick <= MAX_TICK; tick += 977) {
  const cur = getSqrtRatioAtTick(tick);
  if (cur <= prev) {
    monotonic = false;
    console.log(`  not monotonic at tick ${tick}`);
    break;
  }
  prev = cur;
}
assert('strictly increasing across the tick range', monotonic);

let rejected = false;
try {
  getSqrtRatioAtTick(MAX_TICK + 1);
} catch {
  rejected = true;
}
assert('rejects out-of-range ticks', rejected);

// --- LiquidityAmounts ------------------------------------------------------
const L = 1_000_000_000_000_000n;

const inRange = amountsForLiquidity(getSqrtRatioAtTick(0), -600, 600, L);
assert('price inside range → inRange', inRange.inRange);
assert('price inside range → both sides funded', inRange.amount0 > 0n && inRange.amount1 > 0n);
const sideRatio = Number(inRange.amount0) / Number(inRange.amount1);
assert(
  `range symmetric about tick 0 → sides within 1% (ratio ${sideRatio.toFixed(6)})`,
  sideRatio > 0.99 && sideRatio < 1.01,
);

const below = amountsForLiquidity(getSqrtRatioAtTick(-1200), -600, 600, L);
check('price below range → no token1', below.amount1, 0n);
assert('price below range → token0 only', below.amount0 > 0n);
assert('price below range → out of range', !below.inRange);

const above = amountsForLiquidity(getSqrtRatioAtTick(1200), -600, 600, L);
check('price above range → no token0', above.amount0, 0n);
assert('price above range → token1 only', above.amount1 > 0n);
assert('price above range → out of range', !above.inRange);

check(
  'amount0 continuous at the lower boundary',
  amountsForLiquidity(getSqrtRatioAtTick(-600), -600, 600, L).amount0,
  below.amount0,
);
check(
  'amount1 continuous at the upper boundary',
  amountsForLiquidity(getSqrtRatioAtTick(600), -600, 600, L).amount1,
  above.amount1,
);
check('zero liquidity → zero amounts', inRange.amount0 * 0n, 0n);

// --- Fee-growth wrapping ---------------------------------------------------
// The accumulators are uint256 counters that are expected to overflow; only
// their wrapped differences are meaningful.
const MAX_U256 = (1n << 256n) - 1n;
check('subMod256 without wrap', subMod256(500n, 200n), 300n);
check('subMod256 wraps past zero', subMod256(5n, 10n), MAX_U256 - 4n);
check('subMod256 of equal values', subMod256(MAX_U256, MAX_U256), 0n);

// Current tick inside the range: inside == global - outside(lower) - outside(upper).
const inside = feeGrowthInside(
  0,
  -600,
  600,
  { feeGrowthOutside0X128: 100n, feeGrowthOutside1X128: 10n },
  { feeGrowthOutside0X128: 50n, feeGrowthOutside1X128: 5n },
  1000n,
  100n,
);
check('feeGrowthInside token0 (tick inside range)', inside.inside0X128, 850n);
check('feeGrowthInside token1 (tick inside range)', inside.inside1X128, 85n);

// Current tick below the range: the lower tick's accumulator flips sides.
const insideBelow = feeGrowthInside(
  -1000,
  -600,
  600,
  { feeGrowthOutside0X128: 100n, feeGrowthOutside1X128: 10n },
  { feeGrowthOutside0X128: 50n, feeGrowthOutside1X128: 5n },
  1000n,
  100n,
);
check('feeGrowthInside token0 (tick below range)', insideBelow.inside0X128, 50n);

check('feesAccrued scales by liquidity', feesAccrued(1n << 128n, 7n, 4n), 3n);
check('feesAccrued with no growth', feesAccrued(1n << 128n, 7n, 7n), 0n);
check(
  'feesAccrued survives a wrapped accumulator',
  feesAccrued(1n << 128n, 2n, MAX_U256 - 0n),
  3n,
);

console.log(
  failures === 0 ? '\nAll tick math checks passed.' : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
