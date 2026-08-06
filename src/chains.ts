import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  type Chain,
} from 'viem/chains';
import type { Address } from 'viem';

export type ChainKey = 'ethereum' | 'polygon' | 'base' | 'optimism' | 'arbitrum';

export interface ChainConfig {
  key: ChainKey;
  label: string;
  viemChain: Chain;
  // Subdomain used by Alchemy for the JSON-RPC endpoint:
  //   https://<rpcSubdomain>.g.alchemy.com/v2/<API_KEY>
  rpcSubdomain: string;
  // Network identifier expected by Alchemy's Prices API `network` field.
  pricesNetwork: string;
  // Base URL (no trailing slash) of the block explorer used for `/tx/<hash>` links.
  explorerTxBase: string;
  // Base URL (no trailing slash) used for `/address/<addr>` links.
  explorerAddressBase: string;
  // Ticker of the chain's native currency.
  nativeSymbol: string;
  // Canonical wrapped-native ERC-20. Alchemy's Prices API is keyed by token
  // address, so the native currency is priced through its wrapper.
  wrappedNative: Address;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: 'ethereum',
    label: 'Ethereum',
    viemChain: mainnet,
    rpcSubdomain: 'eth-mainnet',
    pricesNetwork: 'eth-mainnet',
    explorerTxBase: 'https://etherscan.io/tx',
    explorerAddressBase: 'https://etherscan.io/address',
    nativeSymbol: 'ETH',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  polygon: {
    key: 'polygon',
    label: 'Polygon',
    viemChain: polygon,
    rpcSubdomain: 'polygon-mainnet',
    pricesNetwork: 'polygon-mainnet',
    explorerTxBase: 'https://polygonscan.com/tx',
    explorerAddressBase: 'https://polygonscan.com/address',
    nativeSymbol: 'POL',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  },
  base: {
    key: 'base',
    label: 'Base',
    viemChain: base,
    rpcSubdomain: 'base-mainnet',
    pricesNetwork: 'base-mainnet',
    explorerTxBase: 'https://basescan.org/tx',
    explorerAddressBase: 'https://basescan.org/address',
    nativeSymbol: 'ETH',
    wrappedNative: '0x4200000000000000000000000000000000000006',
  },
  optimism: {
    key: 'optimism',
    label: 'Optimism',
    viemChain: optimism,
    rpcSubdomain: 'opt-mainnet',
    pricesNetwork: 'opt-mainnet',
    explorerTxBase: 'https://optimistic.etherscan.io/tx',
    explorerAddressBase: 'https://optimistic.etherscan.io/address',
    nativeSymbol: 'ETH',
    wrappedNative: '0x4200000000000000000000000000000000000006',
  },
  arbitrum: {
    key: 'arbitrum',
    label: 'Arbitrum',
    viemChain: arbitrum,
    rpcSubdomain: 'arb-mainnet',
    pricesNetwork: 'arb-mainnet',
    explorerTxBase: 'https://arbiscan.io/tx',
    explorerAddressBase: 'https://arbiscan.io/address',
    nativeSymbol: 'ETH',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
};

export function isChainKey(v: string): v is ChainKey {
  return v in CHAINS;
}

export function rpcUrlFor(chain: ChainConfig, apiKey: string): string {
  return `https://${chain.rpcSubdomain}.g.alchemy.com/v2/${apiKey}`;
}
