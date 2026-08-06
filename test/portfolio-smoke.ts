// Smoke test for the portfolio rewind pipeline.
//
//   export ALCHEMY_API_KEY=YOUR_KEY
//   export CHAIN=base
//   npx esbuild test/portfolio-smoke.ts --bundle --format=esm --platform=node \
//     --target=node20 --outfile=test/portfolio-smoke.bundle.mjs
//   node test/portfolio-smoke.bundle.mjs <account> <asOfISO>
import { createPublicClient, formatUnits, http, isAddress, type Address, type PublicClient } from 'viem';
import { CHAINS, isChainKey, rpcUrlFor } from '../src/chains.js';
import { buildSnapshot, positionValue } from '../src/snapshot.js';

const KEY = process.env.ALCHEMY_API_KEY;
const CHAIN_ARG = (process.env.CHAIN ?? 'base').toLowerCase();
if (!KEY) {
  console.error('ALCHEMY_API_KEY is not set.');
  process.exit(1);
}
if (!isChainKey(CHAIN_ARG)) {
  console.error(`Unknown chain "${CHAIN_ARG}". Use one of: ${Object.keys(CHAINS).join(', ')}.`);
  process.exit(1);
}
const CHAIN = CHAINS[CHAIN_ARG];
const ACCOUNT = process.argv[2];
const AS_OF = process.argv[3] ? Date.parse(process.argv[3]) : NaN;

if (!ACCOUNT || !isAddress(ACCOUNT) || Number.isNaN(AS_OF)) {
  console.error('Usage: CHAIN=base portfolio-smoke.ts <account> <asOfISO>');
  console.error('  e.g. node portfolio-smoke.bundle.mjs 0xabc… 2024-06-01T00:00:00Z');
  process.exit(1);
}

const client = createPublicClient({
  chain: CHAIN.viemChain,
  transport: http(rpcUrlFor(CHAIN, KEY)),
}) as PublicClient;

const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const usd = (n: number | null) =>
  n == null ? '        —' : `$${n.toFixed(2).padStart(12)}`;

const snapshot = await buildSnapshot({
  client,
  chain: CHAIN,
  apiKey: KEY,
  account: ACCOUNT as Address,
  atMs: AS_OF,
  extraTokens: [],
  onProgress: log,
});

if (!snapshot) {
  log('Requested date is before the chain existed.');
  process.exit(0);
}

console.log(`\n=== ${CHAIN.label} portfolio for ${ACCOUNT}`);
console.log(`    requested ${new Date(snapshot.requestedAtMs).toISOString()}`);
console.log(
  `    block ${snapshot.atBlock} @ ${new Date(snapshot.blockTimestampMs).toISOString()}`,
);
console.log(`    ${snapshot.scannedTransfers} transfers scanned`);

console.log(`\n--- Token holdings (${snapshot.holdings.length})`);
for (const h of snapshot.holdings) {
  const amount = formatUnits(h.amount, h.decimals);
  console.log(
    `  ${usd(h.valueUSD)}  ${h.symbol.padEnd(12)} ${amount}${h.priceUSD == null ? '   (no price)' : ''}`,
  );
}

console.log(`\n--- Liquidity positions (${snapshot.positions.length})`);
for (const p of snapshot.positions) {
  const v = positionValue(p, snapshot.prices);
  const label =
    p.kind === 'v2'
      ? `V2 ${p.side0.symbol}/${p.side1.symbol} @ ${p.pair}`
      : `V3 #${p.tokenId} ${p.side0.symbol}/${p.side1.symbol} @ ${p.pool} ` +
        `[${p.tickLower},${p.tickUpper}] current ${p.currentTick} ${p.inRange ? 'IN RANGE' : 'out of range'}`;
  console.log(`  ${usd(v.totalUSD)}  ${label}${v.complete ? '' : '  (partially priced)'}`);
  for (const [side, sv] of [
    [p.side0, v.side0],
    [p.side1, v.side1],
  ] as const) {
    const fees =
      side.feeAmount > 0n
        ? ` + ${formatUnits(side.feeAmount, side.decimals)} fees`
        : '';
    console.log(
      `      ${usd(sv.totalUSD)}  ${side.symbol.padEnd(12)} ${formatUnits(side.amount, side.decimals)}${fees}`,
    );
  }
}

console.log('\n--- Totals');
console.log(`  tokens    ${usd(snapshot.tokensValueUSD)}`);
console.log(`  liquidity ${usd(snapshot.liquidityValueUSD)}`);
console.log(`  TOTAL     ${usd(snapshot.totalValueUSD)}`);

if (snapshot.unpriced.length > 0) {
  console.log(`\n--- Unpriced (${snapshot.unpriced.length})`);
  for (const u of snapshot.unpriced) console.log(`  ${u}`);
}
if (snapshot.warnings.length > 0) {
  console.log('\n--- Warnings');
  for (const w of snapshot.warnings) console.log(`  ${w}`);
}
