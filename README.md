# Cost Basis Calculator

A single-page, fully client-side calculator that computes the **cost basis**
of an ERC-20 token holding for any account on **Ethereum, Polygon, Base,
Optimism, or Arbitrum**, using FIFO, LIFO, or weighted-average accounting.

Two companion pages share the same plumbing: a **transaction CSV export**
(`transactions.html`) and a **portfolio rewind** (`portfolio.html`) that
reconstructs everything an address held on a past date — token balances and
AMM liquidity positions alike — with their USD values that day.

Everything runs in the browser. Your Alchemy API key never leaves the page.

## How it works

1. You provide an account address, a token address, pick the chain from the
   dropdown, and paste your `ALCHEMY_API_KEY`. The RPC URL is derived from
   the chain and API key as
   `https://<network>.g.alchemy.com/v2/<ALCHEMY_API_KEY>`.
2. The page fetches every ERC-20 transfer in/out of the account for the
   given token via `alchemy_getAssetTransfers`.
3. It fetches daily historical USD prices for the token from Alchemy's
   Prices API (using the selected chain as the `network` parameter).
4. It replays the transfers in chronological order and computes:
   - **Remaining holdings** and their cost basis,
   - **Realized proceeds**, **realized cost**, and **realized P&L** from
     outgoing transfers (treated as sales at the price-at-time).

## Build

The runtime dependency is **viem** only. `typescript` and `esbuild` are
build-time tools.

```sh
npm install
npm run build       # type-check, then bundle src/{main,transactions}.ts → dist/
```

The output is static files: `index.html`, `transactions.html`,
`portfolio.html`, and `dist/*.js`. Drop them on any static host (GitHub Pages,
IPFS, S3, `python3 -m http.server`).

## Run locally

```sh
npm run build
npm run serve       # python3 -m http.server 8000
# open http://localhost:8000
```

## Smoke test (optional, Node)

`test/smoke.ts` exercises the same pipeline from the command line with
your env vars, useful when iterating on the algorithm:

```sh
export ALCHEMY_API_KEY=YOUR_KEY
export CHAIN=base   # or ethereum, polygon, optimism, arbitrum
npx esbuild test/smoke.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/smoke.bundle.mjs
node test/smoke.bundle.mjs <account> [token] [fifo|lifo|average]
```

## Transaction CSV export

`transactions.html` is a companion page that downloads **every transaction
touching an address between two dates** as a CSV — native-currency
transfers (external and, where supported, internal), ERC-20, ERC-721, and
ERC-1155, in both directions.

1. You provide an account address, pick the chain, paste your
   `ALCHEMY_API_KEY`, and optionally set **from**/**to** times (UTC).
   Blank bounds mean "from genesis" / "up to now".
2. The date window is resolved to an exact block range by binary-searching
   block timestamps over the RPC endpoint.
3. Two paginated `alchemy_getAssetTransfers` queries (`toAddress` and
   `fromAddress`) pull every transfer in the range across all categories
   the network supports; unsupported categories are dropped automatically.
4. Rows are de-duplicated (self-transfers appear once with direction
   `self`), ERC-1155 batches are expanded to one row per token id, and the
   result is sorted by block number, previewed, and downloaded as CSV.

Columns: `timestamp_utc`, `block_number`, `tx_hash`, `direction`, `from`,
`to`, `category`, `asset`, `amount`, `raw_value`, `contract_address`,
`token_id`, `unique_id`.

A CLI smoke test for this pipeline lives at `test/txhistory-smoke.ts`:

```sh
export ALCHEMY_API_KEY=YOUR_KEY
export CHAIN=base
npx esbuild test/txhistory-smoke.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/txhistory-smoke.bundle.mjs
node test/txhistory-smoke.bundle.mjs <account> [fromISO] [toISO] [out.csv]
```

## Portfolio rewind

`portfolio.html` reconstructs **what an address held at a past instant**: every
token balance at that block with its USD value that day, plus every AMM
liquidity position broken out into the underlying tokens it was worth.

1. You provide an account address, pick the chain, paste your
   `ALCHEMY_API_KEY`, and set the UTC instant to rewind to. An optional
   textarea takes extra token addresses for balances the history scan cannot
   see.
2. The instant is resolved to the last block at or before it, by binary-search
   over block timestamps.
3. A full `alchemy_getAssetTransfers` scan up to that block establishes which
   token and NFT contracts the account has ever touched.
4. Every balance is read **on-chain at that block** (`balanceOf`,
   `eth_getBalance`), batched through Multicall3 where it is available and
   falling back to individual calls otherwise. Reading real state rather than
   summing transfer deltas keeps rebasing and yield-bearing tokens correct.
5. Liquidity positions are detected by contract *shape*, not by a hardcoded
   address list, so forks are picked up without a registry.
6. Daily USD prices for that date come from the Prices API, one request per
   distinct token, including both sides of every pool.

### Liquidity positions

**V2-style LP tokens** — an LP balance is a pro-rata claim on the reserves, so
each side is `lpBalance × reserve / totalSupply`, all read at the target block.
Detected by probing `token0()` / `token1()` / `getReserves()`. Covers Uniswap
V2, SushiSwap, PancakeSwap V2, Aerodrome and Velodrome. The LP token is
reported as a position instead of as a plain holding, so nothing is
double-counted.

**V3-style NFT positions** — concentrated liquidity has no fixed split: the
same position is all token0 below its range, all token1 above it, and a mix in
between. `positions(tokenId)` and the pool's `slot0()` price are read at the
target block and run through Uniswap's `LiquidityAmounts` math (ported to
bigint in `src/tickMath.ts`), with an in-range/out-of-range flag. Ownership is
re-checked with `ownerOf` at that block, so positions later sold or burned
correctly disappear. Uncollected fees are computed in full from the pool's
fee-growth accumulators rather than just the `tokensOwed` checkpoint.

### Limitations specific to this page

- Historical `eth_call` requires **archive** access on the RPC endpoint.
- LP tokens **staked in a gauge or farm** (common on Aerodrome/Velodrome) are
  held by the gauge rather than the wallet, so `balanceOf` reports zero and the
  position is missed.
- ERC-1155 balances are discovered but not valued; plain NFTs are not valued
  either — only liquidity positions are read from NFT contracts.
- Assets that arrived without a transfer event are invisible to the discovery
  scan; paste those contracts into **extra token addresses**.
- Forks whose position manager uses a different `positions()` layout are
  skipped with a note rather than reported wrongly.
- The full-history scan makes the first run slow for very active wallets.

A CLI smoke test lives at `test/portfolio-smoke.ts`:

```sh
export ALCHEMY_API_KEY=YOUR_KEY
export CHAIN=base
npx esbuild test/portfolio-smoke.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/portfolio-smoke.bundle.mjs
node test/portfolio-smoke.bundle.mjs <account> <asOfISO>
```

The concentrated-liquidity math has an offline check that needs no API key —
it verifies `getSqrtRatioAtTick` against Uniswap's published
`MIN_SQRT_RATIO`/`MAX_SQRT_RATIO` constants, the three branches of
`amountsForLiquidity`, and the mod-2²⁵⁶ wrapping the fee-growth accumulators
rely on:

```sh
npx esbuild test/tickmath-check.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/tickmath-check.bundle.mjs
node test/tickmath-check.bundle.mjs
```

## Seeding an initial cost basis (e.g. after a token migration)

The "Initial state (optional)" fieldset lets you start the replay from a
pre-existing balance with a known cost basis instead of from zero. The
typical use case is a **token migration**: compute the cost basis of the
old token, then carry the last remaining amount and remaining USD cost
basis forward as the starting point for the new token.

Fields:
- **Initial amount** — pre-existing balance in the new token's units
  (decimal).
- **Initial cost basis (USD)** — total USD cost attributed to that
  balance. The per-token price of the seeded lot is derived as
  `cost basis / amount`.
- **Start time (UTC, optional)** — transfers with a block timestamp
  strictly before this instant are excluded. Precision is to the second,
  so two transactions in the same block timeframe can be split on either
  side of the cutoff. Use a time on or after the migration so the
  migration-in transfer of the new token is not double-counted against
  the seeded balance.

Behaviour:
- FIFO/LIFO: one synthetic "initial" lot is pushed first. It is consumed
  before any real lot under FIFO, and after every real lot under LIFO.
- Weighted average: the seeded balance and cost are folded into the
  running average before the first transfer is processed.
- When an initial amount is seeded, the computed remaining amount is
  expected to exceed the on-chain `balanceOf` unless you also set a
  start time that excludes the pre-existing balance's origin transfer.

## Output: open and closed lots

Under FIFO and LIFO the results page shows two lot tables:

- **Open lots** — acquisitions that still have tokens remaining.
- **Closed lots** — acquisitions that have been fully consumed by
  disposals, with original amount, cost, accumulated proceeds, and
  realized P&L for the lot. The `Closed` column shows the first → last
  disposal time of that lot; cross-reference the `Realized sales` table
  by tx hash for the per-disposal breakdown.

Weighted average has no lot concept, so both tables are omitted for that
method.

## Notes & limitations

- Requires an **Alchemy** API key because `alchemy_getAssetTransfers` is a
  custom Alchemy method (the standard `eth_getLogs` is capped to 10 blocks
  on the Alchemy free tier and would not work for whole-history scans).
  The key needs to be enabled on whichever of Ethereum, Polygon, Base,
  Optimism, or Arbitrum you want to query.
- USD prices are sampled at **daily granularity** (`1d` interval). For most
  cost-basis use cases this is appropriate; very high-frequency intraday
  moves are smoothed.
- For tokens not covered by Alchemy's price feed on the selected chain, the
  prices request fails and the calculator stops with an error.
- Outgoing transfers are treated as taxable disposals at the
  price-at-time. If you transfer between your own wallets, the calculator
  does **not** know — it will record a sale.
- Tokens with non-standard transfer mechanics (rebases, transfer fees) may
  show a mismatch between computed remaining amount and on-chain
  `balanceOf`; the UI flags this.

## License

MIT — see [LICENSE](LICENSE).
