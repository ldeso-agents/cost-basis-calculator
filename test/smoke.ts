import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { fetchTransfers } from '../src/transfers.js';
import { fetchHistoricalPrices, priceAt } from '../src/prices.js';
import { computeCostBasis, type Method } from '../src/costBasis.js';

const RPC = process.env.BASE_RPC_URL!;
const KEY = process.env.ALCHEMY_API_KEY!;
const ACCOUNT = process.argv[2] as `0x${string}`;
const TOKEN = (process.argv[3] ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`;
const METHOD = (process.argv[4] ?? 'fifo') as Method;

if (!ACCOUNT) {
  console.error('Usage: smoke.ts <account> [token] [method]');
  process.exit(1);
}

const client = createPublicClient({
  chain: base,
  transport: http(RPC),
}) as PublicClient;

const ERC20 = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const [decimalsRaw, symbol, liveBalance] = await Promise.all([
  client.readContract({ address: TOKEN, abi: ERC20, functionName: 'decimals' }),
  client.readContract({ address: TOKEN, abi: ERC20, functionName: 'symbol' }),
  client.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [ACCOUNT] }),
]);
const decimals = Number(decimalsRaw);
log(`Token: ${symbol} (${decimals} decimals), live balance: ${Number(liveBalance) / 10 ** decimals}`);

const transfers = await fetchTransfers(client, TOKEN, ACCOUNT, log);
log(`Got ${transfers.length} transfers (${transfers.filter(t => t.direction === 'in').length} in, ${transfers.filter(t => t.direction === 'out').length} out)`);

if (transfers.length === 0) process.exit(0);

const start = transfers[0]!.timestamp - 86_400_000;
const end = transfers[transfers.length - 1]!.timestamp + 86_400_000;
const prices = await fetchHistoricalPrices(KEY, TOKEN, start, end, log);
log(`Got ${prices.length} price points from ${new Date(prices[0]?.timestamp ?? 0).toISOString().slice(0, 10)} to ${new Date(prices[prices.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}`);

for (const m of ['fifo', 'lifo', 'average'] as Method[]) {
  if (METHOD !== m && process.argv[4]) continue;
  const r = computeCostBasis(transfers, decimals, (ts) => priceAt(prices, ts), m);
  console.log(`\n=== ${m.toUpperCase()} ===`);
  console.log(`Remaining: ${Number(r.remainingAmount) / 10 ** decimals} ${symbol}  (live=${Number(liveBalance) / 10 ** decimals}, match=${r.remainingAmount === liveBalance})`);
  console.log(`Remaining cost basis: $${r.remainingCostBasisUSD.toFixed(2)}`);
  console.log(`Realized proceeds: $${r.realizedProceedsUSD.toFixed(2)}`);
  console.log(`Realized cost:     $${r.realizedCostUSD.toFixed(2)}`);
  console.log(`Realized P&L:      $${r.realizedPnLUSD.toFixed(2)}`);
  console.log(`Sales: ${r.realizedSales.length}, open lots: ${r.remainingLots.length}, warnings: ${r.warnings.length}`);
}
