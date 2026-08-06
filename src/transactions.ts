import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { CHAINS, isChainKey, rpcUrlFor, type ChainConfig } from './chains.js';
import { fetchTxHistory, findBlockRange, toCSV, type TxRecord } from './txHistory.js';
import {
  $,
  fmtDateTime,
  loadField,
  parseUtcInput,
  saveField,
  setStatus,
  shortAddr,
  shortHash,
} from './ui.js';

const PREVIEW_ROWS = 50;

// account/chain/alchemyKey share storage keys with the calculator page so
// values entered on one page carry over to the other.
const FORM_FIELDS = ['account', 'chain', 'alchemyKey', 'txFrom', 'txTo'] as const;

function loadFormFromStorage() {
  for (const f of FORM_FIELDS) {
    const stored = loadField(f);
    if (stored == null) continue;
    if (f === 'chain') {
      if (isChainKey(stored)) ($(f) as HTMLSelectElement).value = stored;
    } else {
      ($(f) as HTMLInputElement).value = stored;
    }
  }
}

function saveFormToStorage() {
  for (const f of FORM_FIELDS) {
    saveField(f, ($(f) as HTMLInputElement | HTMLSelectElement).value);
  }
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderPreview(records: TxRecord[], chain: ChainConfig) {
  const out = $('results');
  if (records.length === 0) {
    out.innerHTML = '<p class="muted">No transactions in this window.</p>';
    return;
  }
  const rows = records
    .slice(0, PREVIEW_ROWS)
    .map(
      (r) => `<tr>
        <td>${fmtDateTime(r.timestamp)}</td>
        <td>${r.direction}</td>
        <td>${r.category}</td>
        <td>${r.asset ?? '—'}</td>
        <td class="num">${r.amount ?? '—'}</td>
        <td title="${r.from}">${shortAddr(r.from)}</td>
        <td title="${r.to ?? ''}">${shortAddr(r.to)}</td>
        <td><a href="${chain.explorerTxBase}/${r.txHash}" target="_blank" rel="noopener">${shortHash(r.txHash)}</a></td>
      </tr>`,
    )
    .join('');
  const more =
    records.length > PREVIEW_ROWS
      ? `<p class="muted">Showing first ${PREVIEW_ROWS} of ${records.length} rows — the CSV contains all of them.</p>`
      : '';
  out.innerHTML = `
    <h2>Preview</h2>
    ${more}
    <table>
      <thead><tr><th>Time (UTC)</th><th>Dir</th><th>Category</th><th>Asset</th><th>Amount</th><th>From</th><th>To</th><th>Tx</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function run() {
  saveFormToStorage();
  $('results').innerHTML = '';

  const account = ($('account') as HTMLInputElement).value.trim();
  const chainKey = ($('chain') as HTMLSelectElement).value;
  const alchemyKey = ($('alchemyKey') as HTMLInputElement).value.trim();
  const fromStr = ($('txFrom') as HTMLInputElement).value.trim();
  const toStr = ($('txTo') as HTMLInputElement).value.trim();

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
  const startMs = parseUtcInput(fromStr);
  if (startMs != null && Number.isNaN(startMs)) {
    setStatus('Invalid "from" time.', 'error');
    return;
  }
  const endMs = parseUtcInput(toStr);
  if (endMs != null && Number.isNaN(endMs)) {
    setStatus('Invalid "to" time.', 'error');
    return;
  }
  if (startMs != null && endMs != null && endMs < startMs) {
    setStatus('"To" must not be earlier than "from".', 'error');
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

    const range = await findBlockRange(client, startMs, endMs, setStatus);
    if (!range) {
      setStatus('No blocks exist in the selected date range.', 'info');
      renderPreview([], chain);
      return;
    }

    const records = await fetchTxHistory(
      client,
      account as Address,
      range,
      setStatus,
    );

    // Block-range resolution is exact to the block, but re-filter on the
    // precise timestamps anyway in case of same-second boundaries.
    const filtered = records.filter(
      (r) =>
        (startMs == null || r.timestamp >= startMs) &&
        (endMs == null || r.timestamp <= endMs),
    );

    renderPreview(filtered, chain);

    if (filtered.length === 0) {
      setStatus('No transactions found in this window; nothing to download.');
      return;
    }

    const label = (ms: number | null, fallback: string) =>
      ms == null ? fallback : new Date(ms).toISOString().slice(0, 10);
    const filename = `transactions-${chainKey}-${account.slice(0, 10)}-${label(startMs, 'genesis')}-${label(endMs, 'latest')}.csv`;
    downloadCSV(toCSV(filtered), filename);
    setStatus(
      `Done. ${filtered.length} rows exported to ${filename} (blocks ${range.fromBlock}–${range.toBlock}).`,
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
