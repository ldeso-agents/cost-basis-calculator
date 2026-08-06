// Resolving AMM liquidity positions to their underlying token amounts, as of
// one historical block.
//
// Two families are covered:
//   * "V2" — an ERC-20 LP token representing a pro-rata claim on two reserves
//     (Uniswap V2, SushiSwap, PancakeSwap V2, Aerodrome, Velodrome).
//   * "V3" — a concentrated-liquidity NFT whose underlying split depends on the
//     pool's price at the block (Uniswap V3 and its forks).
//
// Both are detected by probing contract shape rather than by matching known
// addresses, so forks work without a per-chain registry. The ABIs below are
// deliberately minimal: ABI decoding tolerates trailing return data, so a
// two-output `slot0()` decodes every variant's first two fields, and the
// `uint24 fee` position layout also decodes Slipstream's `int24 tickSpacing`
// (identical on the wire).
import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem';
import type { BlockReader, Call, TokenMetaCache } from './reads.js';
import {
  amountsForLiquidity,
  feeGrowthInside,
  feesAccrued,
  MAX_TICK,
  MIN_TICK,
} from './tickMath.js';

const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

// Uniswap V2 packs reserves as (uint112, uint112, uint32); Solidly-style pools
// use three uint256 words. The wire format is identical for realistic reserve
// sizes, so one ABI decodes both.
const RESERVES3_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);
// Some forks return only the two reserves.
const RESERVES2_ABI = parseAbi([
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1)',
]);

const MANAGER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

const FACTORY_FEE_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);
// Aerodrome/Velodrome Slipstream keys pools by tick spacing instead of fee.
const FACTORY_SPACING_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)',
]);

export interface PooledSide {
  address: Address;
  symbol: string;
  decimals: number;
  // Underlying tokens attributable to the holder's share of the pool.
  amount: bigint;
  // Uncollected trading fees. Always 0n for V2, where fees are already
  // compounded into the reserves.
  feeAmount: bigint;
}

export interface V2Position {
  kind: 'v2';
  pair: Address;
  lpSymbol: string;
  lpDecimals: number;
  lpBalance: bigint;
  lpTotalSupply: bigint;
  side0: PooledSide;
  side1: PooledSide;
}

export interface V3Position {
  kind: 'v3';
  manager: Address;
  tokenId: bigint;
  pool: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  // False when the fee-growth accumulators could not be read, in which case
  // `feeAmount` only reflects already-checkpointed `tokensOwed`.
  feesExact: boolean;
  side0: PooledSide;
  side1: PooledSide;
}

export type LiquidityPosition = V2Position | V3Position;

export function positionTotalAmount(side: PooledSide): bigint {
  return side.amount + side.feeAmount;
}

export interface HoldingInput {
  address: Address;
  balance: bigint;
}

function asAddress(v: unknown): Address | null {
  return typeof v === 'string' && v.startsWith('0x') && v.length === 42
    ? (v as Address)
    : null;
}

function asBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v);
  return null;
}

// Detects which of the account's ERC-20 holdings are V2-style LP tokens and
// converts each balance into its share of the pool's reserves.
export async function findV2Positions(
  reader: BlockReader,
  holdings: HoldingInput[],
  meta: TokenMetaCache,
  warn: (msg: string) => void,
): Promise<V2Position[]> {
  if (holdings.length === 0) return [];

  const probe: Call[] = [];
  for (const h of holdings) {
    probe.push({ address: h.address, abi: PAIR_ABI, functionName: 'token0' });
    probe.push({ address: h.address, abi: PAIR_ABI, functionName: 'token1' });
    probe.push({ address: h.address, abi: erc20Abi, functionName: 'totalSupply' });
    probe.push({ address: h.address, abi: RESERVES3_ABI, functionName: 'getReserves' });
  }
  const probed = await reader.readMany(probe);

  interface Candidate {
    holding: HoldingInput;
    token0: Address;
    token1: Address;
    totalSupply: bigint;
    reserve0: bigint;
    reserve1: bigint;
  }
  const candidates: Candidate[] = [];
  const needsTwoWordReserves: HoldingInput[] = [];
  const partial = new Map<string, { token0: Address; token1: Address; totalSupply: bigint }>();

  holdings.forEach((holding, i) => {
    const token0 = asAddress(probed[i * 4]);
    const token1 = asAddress(probed[i * 4 + 1]);
    const totalSupply = asBigInt(probed[i * 4 + 2]);
    if (!token0 || !token1 || totalSupply == null) return; // not a pair
    if (totalSupply === 0n) return;

    const reserves = probed[i * 4 + 3];
    if (Array.isArray(reserves)) {
      const reserve0 = asBigInt(reserves[0]);
      const reserve1 = asBigInt(reserves[1]);
      if (reserve0 != null && reserve1 != null) {
        candidates.push({ holding, token0, token1, totalSupply, reserve0, reserve1 });
        return;
      }
    }
    partial.set(holding.address.toLowerCase(), { token0, token1, totalSupply });
    needsTwoWordReserves.push(holding);
  });

  if (needsTwoWordReserves.length > 0) {
    const retry = await reader.readMany(
      needsTwoWordReserves.map((h) => ({
        address: h.address,
        abi: RESERVES2_ABI,
        functionName: 'getReserves',
      })),
    );
    needsTwoWordReserves.forEach((holding, i) => {
      const info = partial.get(holding.address.toLowerCase());
      const reserves = retry[i];
      if (!info || !Array.isArray(reserves)) return;
      const reserve0 = asBigInt(reserves[0]);
      const reserve1 = asBigInt(reserves[1]);
      if (reserve0 == null || reserve1 == null) return;
      candidates.push({ holding, ...info, reserve0, reserve1 });
    });
  }

  if (candidates.length === 0) return [];

  await meta.ensure(
    candidates.flatMap((c) => [c.holding.address, c.token0, c.token1]),
  );

  const positions: V2Position[] = [];
  for (const c of candidates) {
    const lpMeta = meta.get(c.holding.address);
    const meta0 = meta.get(c.token0);
    const meta1 = meta.get(c.token1);
    if (!lpMeta || !meta0 || !meta1) {
      warn(
        `Skipped LP token ${c.holding.address}: could not read decimals for the pair or one of its underlying tokens.`,
      );
      continue;
    }
    positions.push({
      kind: 'v2',
      pair: c.holding.address,
      lpSymbol: lpMeta.symbol,
      lpDecimals: lpMeta.decimals,
      lpBalance: c.holding.balance,
      lpTotalSupply: c.totalSupply,
      side0: {
        address: c.token0,
        symbol: meta0.symbol,
        decimals: meta0.decimals,
        amount: (c.holding.balance * c.reserve0) / c.totalSupply,
        feeAmount: 0n,
      },
      side1: {
        address: c.token1,
        symbol: meta1.symbol,
        decimals: meta1.decimals,
        amount: (c.holding.balance * c.reserve1) / c.totalSupply,
        feeAmount: 0n,
      },
    });
  }
  return positions;
}

interface RawPosition {
  manager: Address;
  factory: Address;
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

// `candidates` maps an ERC-721 contract to the token ids the account has ever
// received from it. Ownership is re-checked on-chain at the target block, so
// ids later transferred away or burned drop out here.
export async function findV3Positions(
  reader: BlockReader,
  account: Address,
  candidates: Map<string, Set<string>>,
  meta: TokenMetaCache,
  warn: (msg: string) => void,
): Promise<V3Position[]> {
  const managers = [...candidates.keys()] as Address[];
  if (managers.length === 0) return [];

  // A contract exposing factory() and the V3 position layout is treated as a
  // position manager, whoever deployed it.
  const factoryResults = await reader.readMany(
    managers.map((address) => ({
      address,
      abi: MANAGER_ABI,
      functionName: 'factory',
    })),
  );
  const factories = new Map<string, Address>();
  managers.forEach((manager, i) => {
    const factory = asAddress(factoryResults[i]);
    if (factory && factory !== zeroAddress) factories.set(manager.toLowerCase(), factory);
  });
  if (factories.size === 0) return [];

  const pairs: Array<{ manager: Address; factory: Address; tokenId: bigint }> = [];
  for (const [managerKey, factory] of factories) {
    for (const tokenId of candidates.get(managerKey) ?? []) {
      try {
        pairs.push({ manager: managerKey as Address, factory, tokenId: BigInt(tokenId) });
      } catch {
        // Non-numeric token id; nothing sensible to query.
      }
    }
  }
  if (pairs.length === 0) return [];

  const ownershipCalls: Call[] = [];
  for (const p of pairs) {
    ownershipCalls.push({
      address: p.manager,
      abi: MANAGER_ABI,
      functionName: 'ownerOf',
      args: [p.tokenId],
    });
    ownershipCalls.push({
      address: p.manager,
      abi: MANAGER_ABI,
      functionName: 'positions',
      args: [p.tokenId],
    });
  }
  const ownership = await reader.readMany(ownershipCalls);

  const raw: RawPosition[] = [];
  pairs.forEach((p, i) => {
    const owner = asAddress(ownership[i * 2]);
    // A burned position reverts on ownerOf; a transferred one reports someone
    // else. Either way it was not held at this block.
    if (!owner || owner.toLowerCase() !== account.toLowerCase()) return;

    const fields = ownership[i * 2 + 1];
    if (!Array.isArray(fields) || fields.length < 12) return;

    const token0 = asAddress(fields[2]);
    const token1 = asAddress(fields[3]);
    const liquidity = asBigInt(fields[7]);
    const tokensOwed0 = asBigInt(fields[10]) ?? 0n;
    const tokensOwed1 = asBigInt(fields[11]) ?? 0n;
    if (!token0 || !token1 || liquidity == null) return;
    // A fully withdrawn position with nothing owed contributes no value.
    if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) return;

    raw.push({
      manager: p.manager,
      factory: p.factory,
      tokenId: p.tokenId,
      token0,
      token1,
      fee: Number(fields[4]),
      tickLower: Number(fields[5]),
      tickUpper: Number(fields[6]),
      liquidity,
      feeGrowthInside0LastX128: asBigInt(fields[8]) ?? 0n,
      feeGrowthInside1LastX128: asBigInt(fields[9]) ?? 0n,
      tokensOwed0,
      tokensOwed1,
    });
  });
  if (raw.length === 0) return [];

  // Resolve each position's pool. Try the fee-keyed factory first, then the
  // tick-spacing-keyed Slipstream variant.
  const poolResults = await reader.readMany(
    raw.map((p) => ({
      address: p.factory,
      abi: FACTORY_FEE_ABI,
      functionName: 'getPool',
      args: [p.token0, p.token1, p.fee],
    })),
  );
  const pools = new Array<Address | null>(raw.length).fill(null);
  const spacingRetry: number[] = [];
  raw.forEach((_, i) => {
    const pool = asAddress(poolResults[i]);
    if (pool && pool !== zeroAddress) pools[i] = pool;
    else spacingRetry.push(i);
  });
  if (spacingRetry.length > 0) {
    const retry = await reader.readMany(
      spacingRetry.map((i) => {
        const p = raw[i]!;
        return {
          address: p.factory,
          abi: FACTORY_SPACING_ABI,
          functionName: 'getPool',
          args: [p.token0, p.token1, p.fee],
        };
      }),
    );
    spacingRetry.forEach((idx, i) => {
      const pool = asAddress(retry[i]);
      if (pool && pool !== zeroAddress) pools[idx] = pool;
    });
  }

  const resolved = raw
    .map((p, i) => ({ p, pool: pools[i] }))
    .filter((r): r is { p: RawPosition; pool: Address } => r.pool != null);
  for (const { p } of raw.map((p, i) => ({ p, pool: pools[i] })).filter((r) => r.pool == null)) {
    warn(
      `Skipped position #${p.tokenId} on ${p.manager}: its factory did not resolve a pool for the token pair.`,
    );
  }
  if (resolved.length === 0) return [];

  // Five reads per position: price, both global fee accumulators, and the
  // boundary ticks' outside-accumulators.
  const poolCalls: Call[] = [];
  for (const { p, pool } of resolved) {
    poolCalls.push({ address: pool, abi: POOL_ABI, functionName: 'slot0' });
    poolCalls.push({ address: pool, abi: POOL_ABI, functionName: 'feeGrowthGlobal0X128' });
    poolCalls.push({ address: pool, abi: POOL_ABI, functionName: 'feeGrowthGlobal1X128' });
    poolCalls.push({ address: pool, abi: POOL_ABI, functionName: 'ticks', args: [p.tickLower] });
    poolCalls.push({ address: pool, abi: POOL_ABI, functionName: 'ticks', args: [p.tickUpper] });
  }
  const poolData = await reader.readMany(poolCalls);

  await meta.ensure(resolved.flatMap(({ p }) => [p.token0, p.token1]));

  const positions: V3Position[] = [];
  resolved.forEach(({ p, pool }, i) => {
    const slot0 = poolData[i * 5];
    if (!Array.isArray(slot0)) {
      warn(`Skipped position #${p.tokenId}: could not read slot0() on pool ${pool}.`);
      return;
    }
    const sqrtPriceX96 = asBigInt(slot0[0]);
    const currentTick = Number(slot0[1]);
    if (sqrtPriceX96 == null || !Number.isFinite(currentTick)) {
      warn(`Skipped position #${p.tokenId}: unexpected slot0() shape on pool ${pool}.`);
      return;
    }
    if (
      p.tickLower < MIN_TICK ||
      p.tickUpper > MAX_TICK ||
      p.tickLower >= p.tickUpper
    ) {
      warn(`Skipped position #${p.tokenId}: tick range [${p.tickLower}, ${p.tickUpper}] is invalid.`);
      return;
    }

    const meta0 = meta.get(p.token0);
    const meta1 = meta.get(p.token1);
    if (!meta0 || !meta1) {
      warn(
        `Skipped position #${p.tokenId}: could not read decimals for ${p.token0} / ${p.token1}.`,
      );
      return;
    }

    const { amount0, amount1, inRange } = amountsForLiquidity(
      sqrtPriceX96,
      p.tickLower,
      p.tickUpper,
      p.liquidity,
    );

    // tokensOwed only holds fees checkpointed by the last mint/burn/collect;
    // anything earned since then still sits in the accumulators.
    let fee0 = p.tokensOwed0;
    let fee1 = p.tokensOwed1;
    let feesExact = false;
    const global0 = asBigInt(poolData[i * 5 + 1]);
    const global1 = asBigInt(poolData[i * 5 + 2]);
    const lowerTick = poolData[i * 5 + 3];
    const upperTick = poolData[i * 5 + 4];
    if (
      global0 != null &&
      global1 != null &&
      Array.isArray(lowerTick) &&
      Array.isArray(upperTick)
    ) {
      const lowerOutside0 = asBigInt(lowerTick[2]);
      const lowerOutside1 = asBigInt(lowerTick[3]);
      const upperOutside0 = asBigInt(upperTick[2]);
      const upperOutside1 = asBigInt(upperTick[3]);
      if (
        lowerOutside0 != null &&
        lowerOutside1 != null &&
        upperOutside0 != null &&
        upperOutside1 != null
      ) {
        const inside = feeGrowthInside(
          currentTick,
          p.tickLower,
          p.tickUpper,
          { feeGrowthOutside0X128: lowerOutside0, feeGrowthOutside1X128: lowerOutside1 },
          { feeGrowthOutside0X128: upperOutside0, feeGrowthOutside1X128: upperOutside1 },
          global0,
          global1,
        );
        fee0 += feesAccrued(p.liquidity, inside.inside0X128, p.feeGrowthInside0LastX128);
        fee1 += feesAccrued(p.liquidity, inside.inside1X128, p.feeGrowthInside1LastX128);
        feesExact = true;
      }
    }
    if (!feesExact) {
      warn(
        `Position #${p.tokenId}: fee accumulators unreadable on pool ${pool}; uncollected fees shown are only the checkpointed amount.`,
      );
    }

    positions.push({
      kind: 'v3',
      manager: p.manager,
      tokenId: p.tokenId,
      pool,
      fee: p.fee,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      currentTick,
      inRange,
      feesExact,
      side0: {
        address: p.token0,
        symbol: meta0.symbol,
        decimals: meta0.decimals,
        amount: amount0,
        feeAmount: fee0,
      },
      side1: {
        address: p.token1,
        symbol: meta1.symbol,
        decimals: meta1.decimals,
        amount: amount1,
        feeAmount: fee1,
      },
    });
  });

  return positions;
}
