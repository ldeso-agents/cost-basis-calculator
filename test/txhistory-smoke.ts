// Smoke test for the transaction CSV export pipeline.
//
//   export ALCHEMY_API_KEY=YOUR_KEY
//   export CHAIN=base
//   npx esbuild test/txhistory-smoke.ts --bundle --format=esm --platform=node \
//     --target=node20 --outfile=test/txhistory-smoke.bundle.mjs
//   node test/txhistory-smoke.bundle.mjs <account> [fromISO] [toISO] [out.csv]
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type PublicClient } from 'viem';
import { CHAINS, isChainKey, rpcUrlFor } from '../src/chains.js';
import { fetchTxHistory, findBlockRange, toCSV } from '../src/txHistory.js';

const KEY = process.env.ALCHEMY_API_KEY!;
const CHAIN_ARG = (process.env.CHAIN ?? 'base').toLowerCase();
if (!isChainKey(CHAIN_ARG)) {
  console.error(`Unknown chain "${CHAIN_ARG}". Use one of: ${Object.keys(CHAINS).join(', ')}.`);
  process.exit(1);
}
const CHAIN = CHAINS[CHAIN_ARG];
const ACCOUNT = process.argv[2] as `0x${string}`;
const FROM = process.argv[3] ? Date.parse(process.argv[3]) : null;
const TO = process.argv[4] ? Date.parse(process.argv[4]) : null;
const OUT = process.argv[5];

if (!ACCOUNT || (FROM != null && Number.isNaN(FROM)) || (TO != null && Number.isNaN(TO))) {
  console.error('Usage: CHAIN=base txhistory-smoke.ts <account> [fromISO] [toISO] [out.csv]');
  process.exit(1);
}

const client = createPublicClient({
  chain: CHAIN.viemChain,
  transport: http(rpcUrlFor(CHAIN, KEY)),
}) as PublicClient;

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const range = await findBlockRange(client, FROM, TO, log);
if (!range) {
  log('No blocks in the requested window.');
  process.exit(0);
}
log(`Block range: ${range.fromBlock} → ${range.toBlock}`);

const records = await fetchTxHistory(client, ACCOUNT, range, log);
const dirs = { in: 0, out: 0, self: 0 };
const cats = new Map<string, number>();
for (const r of records) {
  dirs[r.direction]++;
  cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
}
log(`Got ${records.length} rows (in=${dirs.in}, out=${dirs.out}, self=${dirs.self})`);
log(`By category: ${[...cats.entries()].map(([c, n]) => `${c}=${n}`).join(', ') || 'none'}`);
if (records.length > 0) {
  log(`First: ${new Date(records[0]!.timestamp).toISOString()}  Last: ${new Date(records[records.length - 1]!.timestamp).toISOString()}`);
}

const csv = toCSV(records);
if (OUT) {
  writeFileSync(OUT, csv);
  log(`Wrote ${csv.length} bytes to ${OUT}`);
} else {
  console.log('\n--- CSV (first 10 lines) ---');
  console.log(csv.split('\r\n').slice(0, 10).join('\n'));
}
