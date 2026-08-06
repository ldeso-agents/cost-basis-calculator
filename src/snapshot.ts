// Builds a point-in-time portfolio: what an account held at a given instant,
// and what it was worth that day.
//
// The date is resolved to a block, the set of assets to inspect is discovered
// from the account's transfer history up to that block, and every balance is
// then read on-chain *at that block* rather than reconstructed by summing
// transfers. That keeps rebasing and yield-bearing tokens honest, at the cost
// of needing archive access.
import { erc20Abi, isAddress, type Address, type PublicClient } from 'viem';
import type { ChainConfig } from './chains.js';
import { toFloat } from './costBasis.js';
import {
  findV2Positions,
  findV3Positions,
  type LiquidityPosition,
  type PooledSide,
} from './liquidity.js';
import { fetchPricesAt } from './prices.js';
import { BlockReader, TokenMetaCache, type Call } from './reads.js';
import { fetchTxHistory, findBlockRange, type TxRecord } from './txHistory.js';

export type PriceMap = Map<string, number>;

export interface TokenHolding {
  // null for the chain's native currency, which has no contract.
  address: Address | null;
  symbol: string;
  decimals: number;
  amount: bigint;
  priceUSD: number | null;
  valueUSD: number | null;
}

export interface PortfolioSnapshot {
  requestedAtMs: number;
  atBlock: bigint;
  blockTimestampMs: number;
  holdings: TokenHolding[];
  positions: LiquidityPosition[];
  prices: PriceMap;
  tokensValueUSD: number;
  liquidityValueUSD: number;
  totalValueUSD: number;
  // Symbols/addresses Alchemy had no price for; their value is excluded.
  unpriced: string[];
  warnings: string[];
  scannedTransfers: number;
}

function priceKey(address: Address): string {
  return address.toLowerCase();
}

export function usdValue(
  amount: bigint,
  decimals: number,
  price: number | null | undefined,
): number | null {
  if (price == null) return null;
  return toFloat(amount, decimals) * price;
}

export interface SideValue {
  priceUSD: number | null;
  amountUSD: number | null;
  feeUSD: number | null;
  totalUSD: number;
}

export function sideValue(side: PooledSide, prices: PriceMap): SideValue {
  const priceUSD = prices.get(priceKey(side.address)) ?? null;
  const amountUSD = usdValue(side.amount, side.decimals, priceUSD);
  const feeUSD = usdValue(side.feeAmount, side.decimals, priceUSD);
  return {
    priceUSD,
    amountUSD,
    feeUSD,
    totalUSD: (amountUSD ?? 0) + (feeUSD ?? 0),
  };
}

export interface PositionValue {
  side0: SideValue;
  side1: SideValue;
  totalUSD: number;
  // False when either side had no price, so totalUSD understates the position.
  complete: boolean;
}

export function positionValue(
  position: LiquidityPosition,
  prices: PriceMap,
): PositionValue {
  const side0 = sideValue(position.side0, prices);
  const side1 = sideValue(position.side1, prices);
  return {
    side0,
    side1,
    totalUSD: side0.totalUSD + side1.totalUSD,
    complete: side0.priceUSD != null && side1.priceUSD != null,
  };
}

interface Discovered {
  erc20: Address[];
  // ERC-721 contract (lowercased) → token ids ever seen touching the account.
  nfts: Map<string, Set<string>>;
  erc1155: Set<string>;
}

function discover(records: TxRecord[], extra: Address[]): Discovered {
  const erc20 = new Set<string>();
  const nfts = new Map<string, Set<string>>();
  const erc1155 = new Set<string>();

  for (const r of records) {
    const contract = r.contractAddress;
    if (!contract) continue;
    const key = contract.toLowerCase();
    if (r.category === 'erc20') {
      erc20.add(key);
    } else if (r.category === 'erc721' || r.category === 'specialnft') {
      if (r.tokenId == null) continue;
      // Ownership is verified on-chain later, so both directions are kept:
      // an id that left the wallet before the target date drops out then.
      let ids = nfts.get(key);
      if (!ids) {
        ids = new Set();
        nfts.set(key, ids);
      }
      ids.add(r.tokenId);
    } else if (r.category === 'erc1155') {
      erc1155.add(key);
    }
  }

  for (const address of extra) erc20.add(address.toLowerCase());

  return { erc20: [...erc20] as Address[], nfts, erc1155 };
}

export interface SnapshotOptions {
  client: PublicClient;
  chain: ChainConfig;
  apiKey: string;
  account: Address;
  atMs: number;
  extraTokens: Address[];
  onProgress?: (msg: string) => void;
}

export async function buildSnapshot({
  client,
  chain,
  apiKey,
  account,
  atMs,
  extraTokens,
  onProgress,
}: SnapshotOptions): Promise<PortfolioSnapshot | null> {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(msg);

  // 1. Date → block. An open-ended start gives the last block at or before the
  //    requested instant.
  const range = await findBlockRange(client, null, atMs, onProgress);
  if (!range) return null;
  const atBlock = range.toBlock;

  const block = await client.getBlock({ blockNumber: atBlock });
  const blockTimestampMs = Number(block.timestamp) * 1000;

  // 2. Which assets has this account ever touched up to that block?
  const records = await fetchTxHistory(client, account, range, onProgress);
  const found = discover(records, extraTokens);
  onProgress?.(
    `Found ${found.erc20.length} token contracts and ${found.nfts.size} NFT contracts in ${records.length} transfers. Reading balances at block ${atBlock}…`,
  );

  const reader = new BlockReader(client, atBlock);
  const meta = new TokenMetaCache(reader);

  // 3. Balances at the target block.
  const balanceCalls: Call[] = found.erc20.map((address) => ({
    address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  }));
  const [balances, nativeBalance] = await Promise.all([
    reader.readMany(balanceCalls),
    client.getBalance({ address: account, blockNumber: atBlock }),
  ]);

  const held: Array<{ address: Address; balance: bigint }> = [];
  found.erc20.forEach((address, i) => {
    const raw = balances[i];
    if (typeof raw !== 'bigint' || raw === 0n) return;
    held.push({ address, balance: raw });
  });

  await meta.ensure(held.map((h) => h.address));

  // 4. Which of those ERC-20s are actually LP tokens?
  onProgress?.(`Checking ${held.length} token balances for liquidity pools…`);
  const v2Positions = await findV2Positions(reader, held, meta, warn);
  // A pair's LP token is accounted for by its position, so it must not also
  // appear as a plain holding.
  const pairAddresses = new Set(v2Positions.map((p) => p.pair.toLowerCase()));

  // 5. Concentrated-liquidity NFTs.
  onProgress?.(`Checking ${found.nfts.size} NFT contracts for liquidity positions…`);
  const v3Positions = await findV3Positions(reader, account, found.nfts, meta, warn);

  const positions: LiquidityPosition[] = [...v2Positions, ...v3Positions];

  // 6. Everything that needs a price: plain holdings, both sides of every
  //    position, and the wrapped native token standing in for the native coin.
  const plain = held.filter((h) => !pairAddresses.has(h.address.toLowerCase()));
  const priceTargets: Address[] = [chain.wrappedNative];
  for (const h of plain) priceTargets.push(h.address);
  for (const p of positions) {
    priceTargets.push(p.side0.address, p.side1.address);
  }
  const prices = await fetchPricesAt(
    apiKey,
    chain.pricesNetwork,
    priceTargets,
    atMs,
    onProgress,
  );

  // 7. Assemble holdings, native first, then by descending value.
  const holdings: TokenHolding[] = [];
  const nativePrice = prices.get(priceKey(chain.wrappedNative)) ?? null;
  if (nativeBalance > 0n) {
    holdings.push({
      address: null,
      symbol: chain.nativeSymbol,
      decimals: 18,
      amount: nativeBalance,
      priceUSD: nativePrice,
      valueUSD: usdValue(nativeBalance, 18, nativePrice),
    });
  }

  const unpriced: string[] = [];
  const tokenRows: TokenHolding[] = [];
  for (const h of plain) {
    const m = meta.get(h.address);
    if (!m) continue; // decimals unreadable; reported via meta.unreadable()
    const priceUSD = prices.get(priceKey(h.address)) ?? null;
    if (priceUSD == null) unpriced.push(`${m.symbol} (${h.address})`);
    tokenRows.push({
      address: h.address,
      symbol: m.symbol,
      decimals: m.decimals,
      amount: h.balance,
      priceUSD,
      valueUSD: usdValue(h.balance, m.decimals, priceUSD),
    });
  }
  tokenRows.sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0));
  holdings.push(...tokenRows);

  if (nativeBalance > 0n && nativePrice == null) {
    unpriced.push(chain.nativeSymbol);
  }
  for (const p of positions) {
    for (const side of [p.side0, p.side1]) {
      if (prices.get(priceKey(side.address)) == null) {
        unpriced.push(`${side.symbol} (${side.address})`);
      }
    }
  }

  // 8. Totals. Anything unpriced contributes nothing and is listed instead.
  const tokensValueUSD = holdings.reduce((sum, h) => sum + (h.valueUSD ?? 0), 0);
  const liquidityValueUSD = positions.reduce(
    (sum, p) => sum + positionValue(p, prices).totalUSD,
    0,
  );

  const unreadable = meta.unreadable();
  if (unreadable.length > 0) {
    warn(
      `${unreadable.length} contract(s) did not respond to decimals() and were skipped: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', …' : ''}`,
    );
  }
  if (found.erc1155.size > 0) {
    warn(
      `${found.erc1155.size} ERC-1155 contract(s) were seen in the transfer history. ERC-1155 balances are not valued by this page.`,
    );
  }

  return {
    requestedAtMs: atMs,
    atBlock,
    blockTimestampMs,
    holdings,
    positions,
    prices,
    tokensValueUSD,
    liquidityValueUSD,
    totalValueUSD: tokensValueUSD + liquidityValueUSD,
    unpriced: [...new Set(unpriced)],
    warnings,
    scannedTransfers: records.length,
  };
}

// Parses the optional "extra token addresses" field: whitespace-, comma-, or
// newline-separated. Returns the invalid entries so the caller can complain.
export function parseAddressList(input: string): {
  addresses: Address[];
  invalid: string[];
} {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (isAddress(token)) addresses.push(token as Address);
    else invalid.push(token);
  }
  return { addresses, invalid };
}
