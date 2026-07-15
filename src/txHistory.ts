import { hexToBigInt, type Address, type PublicClient } from 'viem';

export type TxDirection = 'in' | 'out' | 'self';

export interface TxRecord {
  timestamp: number; // ms since epoch (block timestamp)
  blockNumber: bigint;
  txHash: `0x${string}`;
  direction: TxDirection;
  from: Address;
  to: Address | null;
  category: string;
  asset: string | null;
  // Decimal-adjusted amount as reported by Alchemy. Null for NFT rows and
  // for tokens whose decimals Alchemy does not know — rawValue keeps the
  // unadjusted amount in those cases.
  amount: number | null;
  rawValue: `0x${string}` | null;
  contractAddress: Address | null;
  tokenId: string | null;
  uniqueId: string;
}

interface RawTransfer {
  category: string;
  blockNum: `0x${string}`;
  from: Address;
  to: Address | null;
  value: number | null;
  erc721TokenId: string | null;
  erc1155Metadata: Array<{ tokenId: string; value: string }> | null;
  tokenId: string | null;
  asset: string | null;
  uniqueId: string;
  hash: `0x${string}`;
  rawContract: {
    value: `0x${string}` | null;
    address: Address | null;
    decimal: `0x${string}` | null;
  };
  metadata: { blockTimestamp: string };
}

interface AssetTransfersResponse {
  transfers: RawTransfer[];
  pageKey?: string;
}

// Every category alchemy_getAssetTransfers knows about. Not all networks
// support all of them (e.g. `internal` and `specialnft` vary by chain), so
// fetching falls back by dropping the categories the RPC error names.
const ALL_CATEGORIES = [
  'external',
  'internal',
  'erc20',
  'erc721',
  'erc1155',
  'specialnft',
] as const;

type RpcRequest = (args: {
  method: string;
  params: unknown[];
}) => Promise<unknown>;

async function getAssetTransfersPage(
  client: PublicClient,
  params: Record<string, unknown>,
): Promise<AssetTransfersResponse> {
  return (await (client.request as RpcRequest)({
    method: 'alchemy_getAssetTransfers',
    params: [params],
  })) as AssetTransfersResponse;
}

async function fetchAll(
  client: PublicClient,
  baseParams: Record<string, unknown>,
  label: string,
  onProgress?: (msg: string) => void,
): Promise<RawTransfer[]> {
  const all: RawTransfer[] = [];
  let pageKey: string | undefined;
  let page = 0;
  do {
    page++;
    onProgress?.(`Fetching ${label} transfers (page ${page})…`);
    const params = { ...baseParams, ...(pageKey ? { pageKey } : {}) };
    const res = await getAssetTransfersPage(client, params);
    all.push(...res.transfers);
    pageKey = res.pageKey;
  } while (pageKey);
  return all;
}

// Probe which categories the connected network accepts by issuing a 1-item
// request and dropping any category the error message names, until the
// request succeeds or no named category remains to drop.
async function supportedCategories(
  client: PublicClient,
  onProgress?: (msg: string) => void,
): Promise<string[]> {
  let categories: string[] = [...ALL_CATEGORIES];
  for (;;) {
    try {
      await getAssetTransfersPage(client, {
        fromBlock: '0x0',
        toBlock: '0x0',
        category: categories,
        maxCount: '0x1',
      });
      return categories;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      const remaining = categories.filter((c) => !msg.includes(c));
      if (remaining.length === categories.length || remaining.length === 0) {
        throw err;
      }
      onProgress?.(
        `Network does not support ${categories
          .filter((c) => msg.includes(c))
          .join(', ')} transfers; continuing without.`,
      );
      categories = remaining;
    }
  }
}

const blockTsCache = new WeakMap<PublicClient, Map<string, number>>();

async function blockTimestampMs(
  client: PublicClient,
  blockNumber: bigint,
): Promise<number> {
  let cache = blockTsCache.get(client);
  if (!cache) {
    cache = new Map();
    blockTsCache.set(client, cache);
  }
  const key = blockNumber.toString();
  const hit = cache.get(key);
  if (hit != null) return hit;
  const block = await client.getBlock({ blockNumber });
  const ms = Number(block.timestamp) * 1000;
  cache.set(key, ms);
  return ms;
}

// Smallest block number in [0, latest] whose timestamp is >= targetMs,
// or null if even the latest block is older than targetMs.
async function firstBlockAtOrAfter(
  client: PublicClient,
  targetMs: number,
  latest: bigint,
): Promise<bigint | null> {
  if ((await blockTimestampMs(client, latest)) < targetMs) return null;
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await blockTimestampMs(client, mid)) >= targetMs) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

// Largest block number in [0, latest] whose timestamp is <= targetMs,
// or null if even the genesis block is newer than targetMs.
async function lastBlockAtOrBefore(
  client: PublicClient,
  targetMs: number,
  latest: bigint,
): Promise<bigint | null> {
  if ((await blockTimestampMs(client, 0n)) > targetMs) return null;
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await blockTimestampMs(client, mid)) <= targetMs) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

// Translate a [startMs, endMs] UTC window into an inclusive block range via
// binary search over block timestamps. Either bound may be null (open-ended).
// Returns null when the window contains no blocks at all.
export async function findBlockRange(
  client: PublicClient,
  startMs: number | null,
  endMs: number | null,
  onProgress?: (msg: string) => void,
): Promise<BlockRange | null> {
  onProgress?.('Resolving date range to block numbers…');
  const latest = await client.getBlockNumber();
  const fromBlock =
    startMs == null ? 0n : await firstBlockAtOrAfter(client, startMs, latest);
  if (fromBlock == null) return null;
  const toBlock =
    endMs == null ? latest : await lastBlockAtOrBefore(client, endMs, latest);
  if (toBlock == null || toBlock < fromBlock) return null;
  return { fromBlock, toBlock };
}

function toHex(n: bigint): `0x${string}` {
  return `0x${n.toString(16)}`;
}

function toRecords(raw: RawTransfer, direction: TxDirection): TxRecord[] {
  const base = {
    timestamp: new Date(raw.metadata.blockTimestamp).getTime(),
    blockNumber: hexToBigInt(raw.blockNum),
    txHash: raw.hash,
    direction,
    from: raw.from,
    to: raw.to,
    category: raw.category,
    asset: raw.asset,
    rawValue: raw.rawContract.value,
    contractAddress: raw.rawContract.address,
    uniqueId: raw.uniqueId,
  };
  // ERC-1155 batch transfers carry per-token amounts in erc1155Metadata;
  // expand them into one row per token id.
  if (raw.erc1155Metadata && raw.erc1155Metadata.length > 0) {
    return raw.erc1155Metadata.map((m) => ({
      ...base,
      amount: Number(hexToBigInt(m.value as `0x${string}`)),
      tokenId: hexToBigInt(m.tokenId as `0x${string}`).toString(),
    }));
  }
  const tokenId = raw.erc721TokenId ?? raw.tokenId;
  return [
    {
      ...base,
      amount: raw.value,
      tokenId:
        tokenId != null ? hexToBigInt(tokenId as `0x${string}`).toString() : null,
    },
  ];
}

// Fetch every transfer touching `account` (all supported categories, both
// directions) within the inclusive block range, sorted chronologically.
export async function fetchTxHistory(
  client: PublicClient,
  account: Address,
  range: BlockRange,
  onProgress?: (msg: string) => void,
): Promise<TxRecord[]> {
  const categories = await supportedCategories(client, onProgress);
  const baseParams = {
    fromBlock: toHex(range.fromBlock),
    toBlock: toHex(range.toBlock),
    category: categories,
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x3e8',
    order: 'asc',
  };

  const [incoming, outgoing] = await Promise.all([
    fetchAll(client, { ...baseParams, toAddress: account }, 'incoming', onProgress),
    fetchAll(client, { ...baseParams, fromAddress: account }, 'outgoing', onProgress),
  ]);

  // A self-transfer shows up in both queries under the same uniqueId.
  const outgoingIds = new Set(outgoing.map((r) => r.uniqueId));
  const records: TxRecord[] = [];
  for (const r of incoming) {
    records.push(...toRecords(r, outgoingIds.has(r.uniqueId) ? 'self' : 'in'));
  }
  for (const r of outgoing) {
    const isSelf = r.to != null && r.to.toLowerCase() === account.toLowerCase();
    if (isSelf) continue; // already emitted as 'self' from the incoming list
    records.push(...toRecords(r, 'out'));
  }

  records.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.uniqueId.localeCompare(b.uniqueId);
  });
  return records;
}

const CSV_HEADER = [
  'timestamp_utc',
  'block_number',
  'tx_hash',
  'direction',
  'from',
  'to',
  'category',
  'asset',
  'amount',
  'raw_value',
  'contract_address',
  'token_id',
  'unique_id',
] as const;

function csvField(v: string | null): string {
  if (v == null) return '';
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function toCSV(records: TxRecord[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of records) {
    lines.push(
      [
        new Date(r.timestamp).toISOString(),
        r.blockNumber.toString(),
        r.txHash,
        r.direction,
        r.from,
        r.to,
        r.category,
        r.asset,
        r.amount != null ? String(r.amount) : null,
        r.rawValue,
        r.contractAddress,
        r.tokenId,
        r.uniqueId,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
