import { hexToBigInt, type Address, type PublicClient } from 'viem';

type Direction = 'in' | 'out';

export interface Transfer {
  direction: Direction;
  amount: bigint;
  blockNumber: bigint;
  uniqueId: string;
  txHash: `0x${string}`;
  timestamp: number;
}

interface RawTransfer {
  blockNum: `0x${string}`;
  uniqueId: string;
  hash: `0x${string}`;
  from: Address;
  to: Address;
  rawContract: { value: `0x${string}`; decimal: `0x${string}`; address: Address };
  metadata: { blockTimestamp: string };
}

interface AssetTransfersResponse {
  transfers: RawTransfer[];
  pageKey?: string;
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
    // alchemy_getAssetTransfers is not in viem's typed RPC schema.
    const res = (await (client.request as (args: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>)({
      method: 'alchemy_getAssetTransfers',
      params: [params],
    })) as AssetTransfersResponse;
    all.push(...res.transfers);
    pageKey = res.pageKey;
  } while (pageKey);
  return all;
}

export async function fetchTransfers(
  client: PublicClient,
  token: Address,
  account: Address,
  onProgress?: (msg: string) => void,
): Promise<Transfer[]> {
  const baseParams = {
    fromBlock: '0x0',
    toBlock: 'latest',
    contractAddresses: [token],
    category: ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x3e8',
    order: 'asc',
  };

  const [incoming, outgoing] = await Promise.all([
    fetchAll(client, { ...baseParams, toAddress: account }, 'incoming', onProgress),
    fetchAll(client, { ...baseParams, fromAddress: account }, 'outgoing', onProgress),
  ]);

  const toTransfer = (r: RawTransfer, direction: Direction): Transfer => ({
    direction,
    amount: hexToBigInt(r.rawContract.value),
    blockNumber: hexToBigInt(r.blockNum),
    uniqueId: r.uniqueId,
    txHash: r.hash,
    timestamp: new Date(r.metadata.blockTimestamp).getTime(),
  });

  const transfers: Transfer[] = [
    ...incoming.map((r) => toTransfer(r, 'in')),
    ...outgoing.map((r) => toTransfer(r, 'out')),
  ];

  transfers.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber)
      return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.uniqueId.localeCompare(b.uniqueId);
  });

  return transfers;
}
