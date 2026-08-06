// Concentrated-liquidity math, ported from Uniswap V3's TickMath and
// LiquidityAmounts libraries. Pure bigint — no network, no floats.

export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const Q256_MASK = (1n << 256n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

// sqrt(1.0001^tick) * 2^96, computed by the standard bit-decomposition: each
// set bit of |tick| multiplies in a precomputed sqrt(1.0001^(2^i)) constant in
// Q128.128, then the Q128.128 result is shifted down to Q64.96.
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick ${tick} out of range`);
  }
  const absTick = BigInt(Math.abs(tick));

  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (bit: bigint, constant: bigint) => {
    if ((absTick & bit) !== 0n) ratio = (ratio * constant) >> 128n;
  };
  mul(0x2n, 0xfff97272373d413259a46990580e213an);
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = (1n << 256n) / ratio;

  // Q128.128 → Q64.96, rounding up so the result never understates the price.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// token0 owed by `liquidity` spread over [sqrtA, sqrtB].
function amount0For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA <= 0n) return 0n;
  return (liquidity * Q96 * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

// token1 owed by `liquidity` spread over [sqrtA, sqrtB].
function amount1For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

export interface PositionAmounts {
  amount0: bigint;
  amount1: bigint;
  // true when the pool's current tick sits inside [tickLower, tickUpper) and
  // the position is therefore actively earning fees.
  inRange: boolean;
}

// Underlying token amounts of a V3 position at the pool's current price.
// Below the range the position is entirely token0, above it entirely token1.
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): PositionAmounts {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);

  if (sqrtPriceX96 <= sqrtA) {
    return {
      amount0: amount0For(sqrtA, sqrtB, liquidity),
      amount1: 0n,
      inRange: false,
    };
  }
  if (sqrtPriceX96 < sqrtB) {
    return {
      amount0: amount0For(sqrtPriceX96, sqrtB, liquidity),
      amount1: amount1For(sqrtA, sqrtPriceX96, liquidity),
      inRange: true,
    };
  }
  return {
    amount0: 0n,
    amount1: amount1For(sqrtA, sqrtB, liquidity),
    inRange: false,
  };
}

// Fee-growth accumulators are uint256 counters that are *expected* to
// overflow; the protocol only ever reads their differences, which stay correct
// under wrapping arithmetic. Plain bigint subtraction would go negative
// instead of wrapping, so every difference is masked back into uint256.
export function subMod256(a: bigint, b: bigint): bigint {
  return (a - b) & Q256_MASK;
}

export interface TickFeeGrowth {
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
}

// feeGrowthInside for a range = global growth minus the growth accumulated
// below the lower tick and above the upper tick. Which side of each tick's
// `outside` accumulator counts depends on where the current tick sits.
export function feeGrowthInside(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  lower: TickFeeGrowth,
  upper: TickFeeGrowth,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
): { inside0X128: bigint; inside1X128: bigint } {
  const below0 =
    currentTick >= tickLower
      ? lower.feeGrowthOutside0X128
      : subMod256(feeGrowthGlobal0X128, lower.feeGrowthOutside0X128);
  const below1 =
    currentTick >= tickLower
      ? lower.feeGrowthOutside1X128
      : subMod256(feeGrowthGlobal1X128, lower.feeGrowthOutside1X128);

  const above0 =
    currentTick < tickUpper
      ? upper.feeGrowthOutside0X128
      : subMod256(feeGrowthGlobal0X128, upper.feeGrowthOutside0X128);
  const above1 =
    currentTick < tickUpper
      ? upper.feeGrowthOutside1X128
      : subMod256(feeGrowthGlobal1X128, upper.feeGrowthOutside1X128);

  return {
    inside0X128: subMod256(subMod256(feeGrowthGlobal0X128, below0), above0),
    inside1X128: subMod256(subMod256(feeGrowthGlobal1X128, below1), above1),
  };
}

// Fees accrued to `liquidity` since the position last recorded
// `feeGrowthInsideLast`, in token units.
export function feesAccrued(
  liquidity: bigint,
  insideX128: bigint,
  insideLastX128: bigint,
): bigint {
  return (liquidity * subMod256(insideX128, insideLastX128)) / Q128;
}
