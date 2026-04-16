import type { Address } from 'viem';

export interface PricePoint {
  timestamp: number;
  value: number;
}

interface AlchemyHistoricalResponse {
  data?: Array<{ value: string; timestamp: string }>;
  error?: { message: string };
}

const PRICES_ENDPOINT = 'https://api.g.alchemy.com/prices/v1';
export const MS_PER_DAY = 86_400_000;
const MAX_DAYS_PER_REQUEST = 365;

export async function fetchHistoricalPrices(
  apiKey: string,
  network: string,
  token: Address,
  startMs: number,
  endMs: number,
  onProgress?: (msg: string) => void,
): Promise<PricePoint[]> {
  const url = `${PRICES_ENDPOINT}/${apiKey}/tokens/historical`;
  const points: PricePoint[] = [];

  let chunkStart = startMs;
  let chunkIndex = 0;
  while (chunkStart < endMs) {
    chunkIndex++;
    const chunkEnd = Math.min(
      endMs,
      chunkStart + MAX_DAYS_PER_REQUEST * MS_PER_DAY,
    );
    onProgress?.(
      `Fetching prices chunk ${chunkIndex} (${new Date(chunkStart).toISOString().slice(0, 10)} → ${new Date(chunkEnd).toISOString().slice(0, 10)})…`,
    );

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        network,
        address: token,
        startTime: new Date(chunkStart).toISOString(),
        endTime: new Date(chunkEnd).toISOString(),
        interval: '1d',
      }),
    });

    const json = (await res.json()) as AlchemyHistoricalResponse;
    if (!res.ok || json.error) {
      throw new Error(
        `Alchemy prices: ${json.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
    for (const d of json.data ?? []) {
      points.push({
        timestamp: new Date(d.timestamp).getTime(),
        value: parseFloat(d.value),
      });
    }

    chunkStart = chunkEnd + 1;
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

export function priceAt(points: PricePoint[], ts: number): number {
  if (points.length === 0) return 0;
  if (ts <= points[0]!.timestamp) return points[0]!.value;
  if (ts >= points[points.length - 1]!.timestamp)
    return points[points.length - 1]!.value;

  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (points[mid]!.timestamp <= ts) lo = mid;
    else hi = mid - 1;
  }
  const before = points[lo]!;
  const after = points[Math.min(lo + 1, points.length - 1)]!;
  return Math.abs(before.timestamp - ts) <= Math.abs(after.timestamp - ts)
    ? before.value
    : after.value;
}
