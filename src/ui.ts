// DOM and formatting helpers shared by every page entry point.
import { formatUnits } from 'viem';
import type { ChainConfig } from './chains.js';

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export function setStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// Form values are persisted under a shared `cbc:` prefix so fields common to
// several pages (account, chain, alchemyKey) carry over between them.
const STORAGE_PREFIX = 'cbc:';

export function loadField(id: string): string | null {
  return sessionStorage.getItem(`${STORAGE_PREFIX}${id}`);
}

export function saveField(id: string, value: string) {
  sessionStorage.setItem(`${STORAGE_PREFIX}${id}`, value);
}

export function fmtUSD(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtAmount(amount: bigint, decimals: number): string {
  const s = formatUnits(amount, decimals);
  const n = Number(s);
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(4);
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// YYYY-MM-DD HH:MM (UTC). Minute precision keeps intra-day ordering visible.
export function fmtDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

// YYYY-MM-DD HH:MM:SS (UTC).
export function fmtDateTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

export function shortHash(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

export function shortAddr(a: string | null): string {
  if (!a) return '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function txLink(chain: ChainConfig, h: `0x${string}`): string {
  return `${chain.explorerTxBase}/${h}`;
}

export function addrLink(chain: ChainConfig, a: string): string {
  return `${chain.explorerAddressBase}/${a}`;
}

// datetime-local value ("YYYY-MM-DD", "…THH:MM", or "…THH:MM:SS"),
// interpreted as UTC. Returns null for an empty field, NaN when unparsable.
export function parseUtcInput(value: string): number | null {
  if (!value) return null;
  const isoUtc =
    value.length === 10
      ? `${value}T00:00:00Z`
      : value.length === 16
        ? `${value}:00Z`
        : `${value}Z`;
  return Date.parse(isoUtc);
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
