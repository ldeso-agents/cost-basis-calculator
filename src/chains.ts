import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  type Chain,
} from 'viem/chains';

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
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: 'ethereum',
    label: 'Ethereum',
    viemChain: mainnet,
    rpcSubdomain: 'eth-mainnet',
    pricesNetwork: 'eth-mainnet',
    explorerTxBase: 'https://etherscan.io/tx',
  },
  polygon: {
    key: 'polygon',
    label: 'Polygon',
    viemChain: polygon,
    rpcSubdomain: 'polygon-mainnet',
    pricesNetwork: 'polygon-mainnet',
    explorerTxBase: 'https://polygonscan.com/tx',
  },
  base: {
    key: 'base',
    label: 'Base',
    viemChain: base,
    rpcSubdomain: 'base-mainnet',
    pricesNetwork: 'base-mainnet',
    explorerTxBase: 'https://basescan.org/tx',
  },
  optimism: {
    key: 'optimism',
    label: 'Optimism',
    viemChain: optimism,
    rpcSubdomain: 'opt-mainnet',
    pricesNetwork: 'opt-mainnet',
    explorerTxBase: 'https://optimistic.etherscan.io/tx',
  },
  arbitrum: {
    key: 'arbitrum',
    label: 'Arbitrum',
    viemChain: arbitrum,
    rpcSubdomain: 'arb-mainnet',
    pricesNetwork: 'arb-mainnet',
    explorerTxBase: 'https://arbiscan.io/tx',
  },
};

export function isChainKey(v: string): v is ChainKey {
  return v in CHAINS;
}

export function rpcUrlFor(chain: ChainConfig, apiKey: string): string {
  return `https://${chain.rpcSubdomain}.g.alchemy.com/v2/${apiKey}`;
}
