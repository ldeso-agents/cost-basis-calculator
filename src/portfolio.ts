import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { CHAINS, isChainKey, rpcUrlFor, type ChainConfig } from './chains.js';
import type { LiquidityPosition, V2Position, V3Position } from './liquidity.js';
import {
  buildSnapshot,
  parseAddressList,
  positionValue,
  type PortfolioSnapshot,
  type SideValue,
  type TokenHolding,
} from './snapshot.js';
import {
  $,
  addrLink,
  escapeHtml,
  fmtAmount,
  fmtDateTime,
  fmtUSD,
  loadField,
  parseUtcInput,
  saveField,
  setStatus,
  shortAddr,
} from './ui.js';

// account/chain/alchemyKey share storage keys with the other pages so values
// entered on one carry over to the others.
const FORM_FIELDS = ['account', 'chain', 'alchemyKey', 'asOf', 'extraTokens'] as const;

function loadFormFromStorage() {
  for (const f of FORM_FIELDS) {
    const stored = loadField(f);
    if (stored == null) continue;
    if (f === 'chain') {
      if (isChainKey(stored)) ($(f) as HTMLSelectElement).value = stored;
    } else {
      ($(f) as HTMLInputElement | HTMLTextAreaElement).value = stored;
    }
  }
}

function saveFormToStorage() {
  for (const f of FORM_FIELDS) {
    saveField(
      f,
      ($(f) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value,
    );
  }
}

function usdCell(value: number | null): string {
  return value == null
    ? '<td class="num muted">—</td>'
    : `<td class="num">${fmtUSD(value)}</td>`;
}

function priceCell(value: number | null): string {
  if (value == null) return '<td class="num muted">no price</td>';
  // Sub-cent prices are common for long-tail tokens; two decimals would read
  // as $0.00.
  const formatted =
    value > 0 && value < 0.01
      ? `$${value.toPrecision(3)}`
      : fmtUSD(value);
  return `<td class="num">${formatted}</td>`;
}

function assetLabel(chain: ChainConfig, symbol: string, address: Address | null): string {
  const label = `<strong>${escapeHtml(symbol)}</strong>`;
  if (!address) return `${label} <span class="muted">native</span>`;
  return `${label} <a class="muted" href="${addrLink(chain, address)}" target="_blank" rel="noopener">${shortAddr(address)}</a>`;
}

function assetCell(chain: ChainConfig, symbol: string, address: Address | null): string {
  return `<td>${assetLabel(chain, symbol, address)}</td>`;
}

function renderHoldings(holdings: TokenHolding[], chain: ChainConfig): string {
  if (holdings.length === 0) {
    return '<tr><td colspan="4" class="muted">No token balances at this block.</td></tr>';
  }
  return holdings
    .map(
      (h) => `<tr>
        ${assetCell(chain, h.symbol, h.address)}
        <td class="num">${fmtAmount(h.amount, h.decimals)}</td>
        ${priceCell(h.priceUSD)}
        ${usdCell(h.valueUSD)}
      </tr>`,
    )
    .join('');
}

// One position renders as a header row plus an indented row per side, so the
// pooled token amounts sit visually underneath the pool they came from.
function sideRows(
  position: LiquidityPosition,
  value: { side0: SideValue; side1: SideValue },
  chain: ChainConfig,
): string {
  return [
    { side: position.side0, v: value.side0 },
    { side: position.side1, v: value.side1 },
  ]
    .map(({ side, v }) => {
      const fees =
        side.feeAmount > 0n
          ? `<div class="muted">+ ${fmtAmount(side.feeAmount, side.decimals)} fees${
              v.feeUSD != null ? ` (${fmtUSD(v.feeUSD)})` : ''
            }</div>`
          : '';
      return `<tr class="side">
        <td class="indent">${assetLabel(chain, side.symbol, side.address)}</td>
        <td class="num">${fmtAmount(side.amount, side.decimals)}${fees}</td>
        ${priceCell(v.priceUSD)}
        ${usdCell(v.priceUSD == null ? null : v.totalUSD)}
      </tr>`;
    })
    .join('');
}

function v2Header(p: V2Position, totalUSD: number, chain: ChainConfig): string {
  const sharePct =
    p.lpTotalSupply > 0n
      ? (Number((p.lpBalance * 1000000n) / p.lpTotalSupply) / 10000).toFixed(4)
      : '0';
  return `<tr class="pool">
    <td colspan="3">
      <strong>${escapeHtml(p.side0.symbol)} / ${escapeHtml(p.side1.symbol)}</strong>
      <span class="tag">V2 LP</span>
      <a class="muted" href="${addrLink(chain, p.pair)}" target="_blank" rel="noopener">${shortAddr(p.pair)}</a>
      <div class="muted">${fmtAmount(p.lpBalance, p.lpDecimals)} ${escapeHtml(p.lpSymbol)} — ${sharePct}% of pool</div>
    </td>
    <td class="num"><strong>${fmtUSD(totalUSD)}</strong></td>
  </tr>`;
}

function v3Header(p: V3Position, totalUSD: number, chain: ChainConfig): string {
  const rangeTag = p.inRange
    ? '<span class="tag in-range">in range</span>'
    : '<span class="tag out-range">out of range</span>';
  const feeTier = Number.isFinite(p.fee) ? `${(p.fee / 10000).toFixed(2)}%` : '—';
  const feeNote = p.feesExact ? '' : ' <span class="muted">(fees approximate)</span>';
  return `<tr class="pool">
    <td colspan="3">
      <strong>${escapeHtml(p.side0.symbol)} / ${escapeHtml(p.side1.symbol)}</strong>
      <span class="tag">V3 #${p.tokenId}</span>
      ${rangeTag}
      <a class="muted" href="${addrLink(chain, p.pool)}" target="_blank" rel="noopener">${shortAddr(p.pool)}</a>
      <div class="muted">
        fee tier ${feeTier} · ticks ${p.tickLower} → ${p.tickUpper} (current ${p.currentTick})${feeNote}
      </div>
    </td>
    <td class="num"><strong>${fmtUSD(totalUSD)}</strong></td>
  </tr>`;
}

function renderPositions(snapshot: PortfolioSnapshot, chain: ChainConfig): string {
  if (snapshot.positions.length === 0) {
    return '<tr><td colspan="4" class="muted">No liquidity positions at this block.</td></tr>';
  }
  const withValues = snapshot.positions.map((p) => ({
    position: p,
    value: positionValue(p, snapshot.prices),
  }));
  withValues.sort((a, b) => b.value.totalUSD - a.value.totalUSD);

  return withValues
    .map(({ position, value }) => {
      const header =
        position.kind === 'v2'
          ? v2Header(position, value.totalUSD, chain)
          : v3Header(position, value.totalUSD, chain);
      return header + sideRows(position, value, chain);
    })
    .join('');
}

function renderNotices(snapshot: PortfolioSnapshot): string {
  const blocks: string[] = [];
  if (snapshot.unpriced.length > 0) {
    blocks.push(
      `<div class="warn"><strong>No price data for ${snapshot.unpriced.length} asset(s)</strong> — their amounts are shown but excluded from the totals:<ul>${snapshot.unpriced
        .map((u) => `<li>${escapeHtml(u)}</li>`)
        .join('')}</ul></div>`,
    );
  }
  if (snapshot.warnings.length > 0) {
    blocks.push(
      `<div class="warn"><strong>Notes:</strong><ul>${snapshot.warnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join('')}</ul></div>`,
    );
  }
  return blocks.join('');
}

function renderSnapshot(snapshot: PortfolioSnapshot, chain: ChainConfig) {
  const drift = Math.abs(snapshot.blockTimestampMs - snapshot.requestedAtMs);
  const driftNote =
    drift > 60_000
      ? ` <span class="muted">(nearest block is ${Math.round(drift / 60_000)} min earlier)</span>`
      : '';

  $('results').innerHTML = `
    <h2>Portfolio at ${fmtDateTime(snapshot.blockTimestampMs)} UTC</h2>
    <p class="muted">
      ${chain.label} · block ${snapshot.atBlock} · ${snapshot.scannedTransfers} transfers scanned${driftNote}
    </p>
    ${renderNotices(snapshot)}

    <table class="totals">
      <tr><td>Tokens</td><td class="num">${fmtUSD(snapshot.tokensValueUSD)}</td></tr>
      <tr><td>Liquidity positions</td><td class="num">${fmtUSD(snapshot.liquidityValueUSD)}</td></tr>
      <tr><td>Total</td><td class="num"><strong>${fmtUSD(snapshot.totalValueUSD)}</strong></td></tr>
    </table>

    <details class="section" open>
      <summary>Token holdings (${snapshot.holdings.length})</summary>
      <table>
        <thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Price that day</th><th class="num">USD value</th></tr></thead>
        <tbody>${renderHoldings(snapshot.holdings, chain)}</tbody>
      </table>
    </details>

    <details class="section" open>
      <summary>Liquidity positions (${snapshot.positions.length})</summary>
      <table class="positions">
        <thead><tr><th>Position / asset</th><th class="num">Amount</th><th class="num">Price that day</th><th class="num">USD value</th></tr></thead>
        <tbody>${renderPositions(snapshot, chain)}</tbody>
      </table>
    </details>
  `;
}

async function run() {
  saveFormToStorage();
  $('results').innerHTML = '';

  const account = ($('account') as HTMLInputElement).value.trim();
  const chainKey = ($('chain') as HTMLSelectElement).value;
  const alchemyKey = ($('alchemyKey') as HTMLInputElement).value.trim();
  const asOfStr = ($('asOf') as HTMLInputElement).value.trim();
  const extraStr = ($('extraTokens') as HTMLTextAreaElement).value.trim();

  if (!isAddress(account)) {
    setStatus('Invalid account address.', 'error');
    return;
  }
  if (!isChainKey(chainKey)) {
    setStatus('Invalid chain selection.', 'error');
    return;
  }
  if (!alchemyKey) {
    setStatus('ALCHEMY_API_KEY is required.', 'error');
    return;
  }
  const atMs = parseUtcInput(asOfStr);
  if (atMs == null) {
    setStatus('Pick a date to rewind to.', 'error');
    return;
  }
  if (Number.isNaN(atMs)) {
    setStatus('Invalid "as of" time.', 'error');
    return;
  }
  const { addresses: extraTokens, invalid } = parseAddressList(extraStr);
  if (invalid.length > 0) {
    setStatus(`Not a valid address: ${invalid[0]}`, 'error');
    return;
  }

  const chain = CHAINS[chainKey];
  const button = $('go') as HTMLButtonElement;
  button.disabled = true;

  try {
    const client = createPublicClient({
      chain: chain.viemChain,
      transport: http(rpcUrlFor(chain, alchemyKey)),
    }) as PublicClient;

    const snapshot = await buildSnapshot({
      client,
      chain,
      apiKey: alchemyKey,
      account: account as Address,
      atMs,
      extraTokens,
      onProgress: setStatus,
    });

    if (!snapshot) {
      setStatus(
        'That date is earlier than the chain’s first block — nothing to show.',
        'info',
      );
      return;
    }

    renderSnapshot(snapshot, chain);
    setStatus(
      `Done. ${snapshot.holdings.length} token holdings and ${snapshot.positions.length} liquidity positions at block ${snapshot.atBlock}.`,
    );
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadFormFromStorage();
  ($('form') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
});
