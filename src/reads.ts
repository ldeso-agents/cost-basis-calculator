// Historical contract reads: everything here is evaluated at one fixed block,
// so a snapshot reflects on-chain state as it actually was rather than a
// balance reconstructed from transfer deltas.
import {
  erc20Abi,
  hexToString,
  parseAbi,
  trim,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

// Parallel `eth_call` fan-out when Multicall3 is unavailable. Kept modest so a
// wallet with hundreds of tokens does not trip Alchemy's rate limits.
const FALLBACK_CONCURRENCY = 6;

export class BlockReader {
  // Multicall3 is only usable at blocks after its deployment, and viem refuses
  // the call below `blockCreated`. The first failure flips this off for good.
  private multicallUsable = true;

  constructor(
    readonly client: PublicClient,
    readonly blockNumber: bigint,
  ) {}

  // Results are positional and `null` marks a failed call — a reverting or
  // non-conforming contract must never abort a whole snapshot.
  async readMany(calls: Call[]): Promise<(unknown | null)[]> {
    if (calls.length === 0) return [];

    if (this.multicallUsable) {
      try {
        // viem's multicall types are built around statically known ABIs; these
        // calls are assembled at runtime, so the result is narrowed by hand.
        const results = (await this.client.multicall({
          contracts: calls as never,
          blockNumber: this.blockNumber,
          allowFailure: true,
        })) as unknown as Array<
          { status: 'success'; result: unknown } | { status: 'failure' }
        >;
        return results.map((r) => (r.status === 'success' ? r.result : null));
      } catch {
        this.multicallUsable = false;
      }
    }

    return this.readSequential(calls);
  }

  private async readSequential(calls: Call[]): Promise<(unknown | null)[]> {
    const out: (unknown | null)[] = new Array(calls.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= calls.length) return;
        const call = calls[i]!;
        try {
          out[i] = await this.client.readContract({
            address: call.address,
            abi: call.abi,
            functionName: call.functionName,
            args: call.args as never,
            blockNumber: this.blockNumber,
          });
        } catch {
          out[i] = null;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FALLBACK_CONCURRENCY, calls.length) }, worker),
    );
    return out;
  }

  async read(call: Call): Promise<unknown | null> {
    const [result] = await this.readMany([call]);
    return result ?? null;
  }
}

export interface TokenMeta {
  address: Address;
  symbol: string;
  decimals: number;
}

// A handful of pre-EIP-20-final tokens (MKR, SAI, …) return a padded bytes32
// rather than a string from symbol().
const BYTES32_SYMBOL_ABI = parseAbi(['function symbol() view returns (bytes32)']);

function normalizeKey(a: Address): string {
  return a.toLowerCase();
}

// Fetches and caches symbol/decimals, so a token appearing both as a direct
// holding and as one side of a pool is only read once.
export class TokenMetaCache {
  private cache = new Map<string, TokenMeta>();
  // Addresses whose decimals() could not be read: they cannot be formatted or
  // valued, so callers drop them rather than guess at 18.
  private failed = new Set<string>();

  constructor(private reader: BlockReader) {}

  get(address: Address): TokenMeta | null {
    return this.cache.get(normalizeKey(address)) ?? null;
  }

  unreadable(): string[] {
    return [...this.failed];
  }

  async ensure(addresses: Address[]): Promise<void> {
    const missing = [
      ...new Set(
        addresses
          .map(normalizeKey)
          .filter((k) => !this.cache.has(k) && !this.failed.has(k)),
      ),
    ] as Address[];
    if (missing.length === 0) return;

    const calls: Call[] = [];
    for (const address of missing) {
      calls.push({ address, abi: erc20Abi, functionName: 'decimals' });
      calls.push({ address, abi: erc20Abi, functionName: 'symbol' });
    }
    const results = await this.readMany(calls);

    // Retry symbol() as bytes32 only where the string decode failed.
    const bytes32Retry: Address[] = [];
    missing.forEach((address, i) => {
      if (results[i * 2] != null && results[i * 2 + 1] == null) {
        bytes32Retry.push(address);
      }
    });
    const bytes32Results = await this.readMany(
      bytes32Retry.map((address) => ({
        address,
        abi: BYTES32_SYMBOL_ABI,
        functionName: 'symbol',
      })),
    );
    const bytes32Symbols = new Map<string, string>();
    bytes32Retry.forEach((address, i) => {
      const raw = bytes32Results[i];
      if (typeof raw !== 'string') return;
      const text = hexToString(trim(raw as `0x${string}`, { dir: 'right' }));
      if (text) bytes32Symbols.set(normalizeKey(address), text);
    });

    missing.forEach((address, i) => {
      const key = normalizeKey(address);
      const decimalsRaw = results[i * 2];
      if (decimalsRaw == null) {
        this.failed.add(key);
        return;
      }
      const symbolRaw = results[i * 2 + 1];
      const symbol =
        typeof symbolRaw === 'string' && symbolRaw.length > 0
          ? symbolRaw
          : (bytes32Symbols.get(key) ?? `${address.slice(0, 6)}…`);
      this.cache.set(key, {
        address,
        symbol,
        decimals: Number(decimalsRaw as bigint | number),
      });
    });
  }

  private readMany(calls: Call[]): Promise<(unknown | null)[]> {
    return this.reader.readMany(calls);
  }
}
