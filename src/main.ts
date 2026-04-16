import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { fetchTransfers } from './transfers.js';
import { fetchHistoricalPrices, MS_PER_DAY, priceAt } from './prices.js';
import {
  computeCostBasis,
  toFloat,
  type CostBasisResult,
  type Method,
} from './costBasis.js';

const DEFAULT_METHOD: Method = 'fifo';

const FORM_FIELDS = ['account', 'token', 'rpcUrl', 'alchemyKey', 'method'] as const;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function loadFormFromStorage() {
  for (const f of FORM_FIELDS) {
    const stored = sessionStorage.getItem(`cbc:${f}`);
    if (stored == null) continue;
    if (f === 'method') {
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="method"][value="${stored}"]`,
      );
      if (radio) radio.checked = true;
    } else {
      ($(f) as HTMLInputElement).value = stored;
    }
  }
}

function saveFormToStorage() {
  for (const f of FORM_FIELDS) {
    if (f === 'method') {
      const checked = document.querySelector<HTMLInputElement>(
        'input[name="method"]:checked',
      );
      if (checked) sessionStorage.setItem(`cbc:${f}`, checked.value);
    } else {
      sessionStorage.setItem(`cbc:${f}`, ($(f) as HTMLInputElement).value);
    }
  }
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

function fmtUSD(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAmount(amount: bigint, decimals: number): string {
  const s = formatUnits(amount, decimals);
  const n = Number(s);
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(4);
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function shortHash(h: `0x${string}`): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function txLink(h: `0x${string}`): string {
  return `https://basescan.org/tx/${h}`;
}

function renderResult(
  result: CostBasisResult,
  symbol: string,
  decimals: number,
  liveBalance: bigint,
) {
  const out = $('results');
  const method = result.method;

  const balanceMismatch = result.remainingAmount !== liveBalance;
  const mismatchHTML = balanceMismatch
    ? `<p class="warn">⚠ Computed balance ${fmtAmount(result.remainingAmount, decimals)} ${symbol} differs from on-chain balance ${fmtAmount(liveBalance, decimals)} ${symbol}. The token may have non-standard transfer logic (rebases, fees, etc.).</p>`
    : '';

  const warningsHTML =
    result.warnings.length === 0
      ? ''
      : `<div class="warn"><strong>Warnings:</strong><ul>${result.warnings
          .map((w) => `<li>${w}</li>`)
          .join('')}</ul></div>`;

  const lotRow = (
    acquired: string,
    amount: bigint,
    price: number,
    tx: string,
  ): string => {
    const usd = toFloat(amount, decimals) * price;
    return `<tr>
      <td>${acquired}</td>
      <td class="num">${fmtAmount(amount, decimals)}</td>
      <td class="num">${fmtUSD(price)}</td>
      <td class="num">${fmtUSD(usd)}</td>
      <td>${tx}</td>
    </tr>`;
  };

  let lotsRows: string;
  if (result.averageSummary) {
    const s = result.averageSummary;
    lotsRows = lotRow('—', s.amount, s.pricePerToken, '<span class="muted">averaged</span>');
  } else if (result.remainingLots.length === 0) {
    lotsRows = `<tr><td colspan="5" class="muted">No remaining holdings.</td></tr>`;
  } else {
    lotsRows = result.remainingLots
      .map((l) =>
        lotRow(
          fmtDate(l.acquiredAt),
          l.amount,
          l.pricePerToken,
          `<a href="${txLink(l.txHash)}" target="_blank" rel="noopener">${shortHash(l.txHash)}</a>`,
        ),
      )
      .join('');
  }

  const salesRows =
    result.realizedSales.length === 0
      ? `<tr><td colspan="5" class="muted">No outgoing transfers.</td></tr>`
      : result.realizedSales
          .map(
            (s) => `<tr>
              <td>${fmtDate(s.soldAt)}</td>
              <td class="num">${fmtAmount(s.amount, decimals)}</td>
              <td class="num">${fmtUSD(s.proceedsUSD)}</td>
              <td class="num">${fmtUSD(s.costUSD)}</td>
              <td class="num ${s.pnlUSD >= 0 ? 'pos' : 'neg'}">${fmtUSD(s.pnlUSD)}</td>
              <td><a href="${txLink(s.txHash)}" target="_blank" rel="noopener">${shortHash(s.txHash)}</a></td>
            </tr>`,
          )
          .join('');

  out.innerHTML = `
    <h2>${symbol} — ${method.toUpperCase()}</h2>
    ${mismatchHTML}
    ${warningsHTML}
    <table class="totals">
      <tr><td>Remaining amount</td><td class="num">${fmtAmount(result.remainingAmount, decimals)} ${symbol}</td></tr>
      <tr><td>Remaining cost basis</td><td class="num">${fmtUSD(result.remainingCostBasisUSD)}</td></tr>
      <tr><td>Realized proceeds</td><td class="num">${fmtUSD(result.realizedProceedsUSD)}</td></tr>
      <tr><td>Realized cost</td><td class="num">${fmtUSD(result.realizedCostUSD)}</td></tr>
      <tr><td>Realized P&amp;L</td><td class="num ${result.realizedPnLUSD >= 0 ? 'pos' : 'neg'}">${fmtUSD(result.realizedPnLUSD)}</td></tr>
    </table>

    <h3>Open lots</h3>
    <table>
      <thead><tr><th>Acquired</th><th>Amount</th><th>Price/token</th><th>Cost basis</th><th>Tx</th></tr></thead>
      <tbody>${lotsRows}</tbody>
    </table>

    <h3>Realized sales</h3>
    <table>
      <thead><tr><th>Date</th><th>Amount</th><th>Proceeds</th><th>Cost</th><th>P&amp;L</th><th>Tx</th></tr></thead>
      <tbody>${salesRows}</tbody>
    </table>
  `;
}

async function run() {
  saveFormToStorage();
  $('results').innerHTML = '';

  const account = ($('account') as HTMLInputElement).value.trim();
  const token = ($('token') as HTMLInputElement).value.trim();
  const rpcUrl = ($('rpcUrl') as HTMLInputElement).value.trim();
  const alchemyKey = ($('alchemyKey') as HTMLInputElement).value.trim();
  const method = (
    document.querySelector<HTMLInputElement>('input[name="method"]:checked')
      ?.value ?? DEFAULT_METHOD
  ) as Method;

  if (!isAddress(account)) {
    setStatus('Invalid account address.', 'error');
    return;
  }
  if (!isAddress(token)) {
    setStatus('Invalid token address.', 'error');
    return;
  }
  if (!rpcUrl) {
    setStatus('BASE_RPC_URL is required.', 'error');
    return;
  }
  if (!alchemyKey) {
    setStatus('ALCHEMY_API_KEY is required.', 'error');
    return;
  }

  const button = $('go') as HTMLButtonElement;
  button.disabled = true;

  try {
    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    }) as PublicClient;

    setStatus('Reading token metadata…');
    const tokenAddr = token as Address;
    const accountAddr = account as Address;
    const [decimalsRaw, symbol, liveBalance] = await Promise.all([
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({
        address: tokenAddr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddr],
      }),
    ]);
    const decimals = Number(decimalsRaw);

    const transfers = await fetchTransfers(client, tokenAddr, accountAddr, setStatus);

    if (transfers.length === 0) {
      setStatus('No transfers found for this account/token.', 'info');
      renderResult(
        computeCostBasis([], decimals, () => 0, method),
        symbol,
        decimals,
        liveBalance,
      );
      return;
    }

    const startMs = transfers[0]!.timestamp - MS_PER_DAY;
    const endMs = transfers[transfers.length - 1]!.timestamp + MS_PER_DAY;
    const prices = await fetchHistoricalPrices(
      alchemyKey,
      tokenAddr,
      startMs,
      endMs,
      setStatus,
    );

    if (prices.length === 0) {
      setStatus(
        'No price data returned by Alchemy for this token. Cannot compute USD cost basis.',
        'error',
      );
      return;
    }

    setStatus(
      `Computing cost basis from ${transfers.length} transfers and ${prices.length} price points…`,
    );
    const result = computeCostBasis(
      transfers,
      decimals,
      (ts) => priceAt(prices, ts),
      method,
    );

    renderResult(result, symbol, decimals, liveBalance);
    setStatus(
      `Done. ${transfers.length} transfers processed, ${result.realizedSales.length} sales realized.`,
    );
  } catch (err) {
    console.error(err);
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
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
