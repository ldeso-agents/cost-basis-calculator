# Cost Basis Calculator

A single-page, fully client-side calculator that computes the **cost basis**
of an ERC-20 token holding for any account on **Base mainnet**, using FIFO,
LIFO, or weighted-average accounting.

Everything runs in the browser. Your Alchemy API key never leaves the page.

## How it works

1. You provide an account address, a token address, your `BASE_RPC_URL`
   (an Alchemy URL), and your `ALCHEMY_API_KEY`.
2. The page fetches every ERC-20 transfer in/out of the account for the
   given token via `alchemy_getAssetTransfers`.
3. It fetches daily historical USD prices for the token from Alchemy's
   Prices API.
4. It replays the transfers in chronological order and computes:
   - **Remaining holdings** and their cost basis,
   - **Realized proceeds**, **realized cost**, and **realized P&L** from
     outgoing transfers (treated as sales at the price-at-time).

## Build

The runtime dependency is **viem** only. `typescript` and `esbuild` are
build-time tools.

```sh
npm install
npm run build       # type-check, then bundle src/main.ts → dist/bundle.js
```

The output is two static files: `index.html` and `dist/bundle.js`. Drop
them on any static host (GitHub Pages, IPFS, S3, `python3 -m http.server`).

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
export BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
export ALCHEMY_API_KEY=YOUR_KEY
npx esbuild test/smoke.ts --bundle --format=esm --platform=node \
  --target=node20 --outfile=test/smoke.bundle.mjs
node test/smoke.bundle.mjs <account> [token] [fifo|lifo|average]
```

## Notes & limitations

- Requires an **Alchemy** RPC URL because `alchemy_getAssetTransfers` is a
  custom Alchemy method (the standard `eth_getLogs` is capped to 10 blocks
  on the Alchemy free tier and would not work for whole-history scans).
- USD prices are sampled at **daily granularity** (`1d` interval). For most
  cost-basis use cases this is appropriate; very high-frequency intraday
  moves are smoothed.
- For tokens not covered by Alchemy's price feed, the prices request fails
  and the calculator stops with an error. Consider using a token Alchemy
  tracks (it covers most major Base tokens).
- Outgoing transfers are treated as taxable disposals at the
  price-at-time. If you transfer between your own wallets, the calculator
  does **not** know — it will record a sale.
- Tokens with non-standard transfer mechanics (rebases, transfer fees) may
  show a mismatch between computed remaining amount and on-chain
  `balanceOf`; the UI flags this.

## License

MIT — see [LICENSE](LICENSE).
