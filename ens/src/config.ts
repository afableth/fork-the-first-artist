/**
 * Config for the ENS issuing service.
 *
 * Everything comes from the environment; nothing is invented. Two rules shape
 * this file, both inherited from the project's design decisions:
 *
 * 1. **The parent name is not ours to choose.** The owner supplies it. Until it
 *    is set, config loads fine but every issuing path refuses to run — a fresh
 *    clone must boot, and it must not mint names from a namespace nobody approved.
 * 2. **Contract addresses are data, not guesses.** The registry ships with its
 *    canonical address (identical on mainnet and Sepolia); the resolver is an
 *    explicit env var so an operator must confirm it per chain before any write.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAddress } from 'ethers';

/**
 * `dev`  — synthetic HCS message ids + invite tokens from an env allowlist.
 *          Zero credentials; the chain calls still need real config to run.
 * `live` — real HCS topic submit; invite tokens are read back from the topic
 *          through the mirror node.
 *
 * Same convention as payments/: there is no `prod`, because this repo is a
 * hackathon testnet demo and a mode name implying production safety would lie.
 */
export type Mode = 'dev' | 'live';

export interface Config {
  mode: Mode;
  port: number;
  /** Sepolia (demo) JSON-RPC endpoint. Mainnet is design-approved, not authorized. */
  rpcUrl?: string;
  /** The parent name the owner will supply, e.g. `oso.eth`. Absent until then. */
  parentName?: string;
  /** Private key of the parent owner — testnet/demo only, `.env` never committed. */
  parentOwnerKey?: string;
  /** ENS registry contract (canonical address by default). */
  registryAddress: string;
  /** Public resolver that will hold the artist's records; confirmed per chain. */
  resolverAddress?: string;
  /** CAIP-2 style, e.g. `hedera:testnet` — same convention as payments/. */
  hederaNetwork: string;
  /** HCS topic that receives claim events (shared topic family with payments/). */
  hcsClaimTopicId?: string;
  /** Operator account/key that submits to the topic. Server-side only. */
  hcsAccountId?: string;
  hcsPrivateKey?: string;
  /** Mirror node REST base, used to read invite announcements back. */
  mirrorNodeUrl: string;
  /** One-time invite tokens for dev mode. In live mode tokens come from HCS. */
  inviteTokens: string[];
  /** Runtime state (claim log, used invites). Output, not source — gitignored. */
  dataDir: string;
}

/**
 * The ENS registry. It lives at the same canonical address on Ethereum mainnet
 * and Sepolia, so one constant covers both chains. Overridable for a local
 * anvil deployment or a future ENSv2 registry migration.
 */
export const DEFAULT_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

/** Minimal `.env` reader: no dependency, silent when absent, real env always wins. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // `=== undefined` so `PORT=9000 npm start` overrides .env, not the reverse
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Treat an empty string as "not set" — an empty key is always a mistake, never a value. */
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};

const num = (k: string, fallback: number): number => {
  const v = env(k);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env ${k} must be a positive number, got ${JSON.stringify(v)}`);
  return n;
};

/** Every ENS name is dot-separated labels; this is the cheap structural check. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isValidName(name: string): boolean {
  const labels = name.toLowerCase().split('.');
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l));
}

/** Load and validate config. Throws on structural errors; missing optional pieces stay absent. */
export function loadConfig(): Config {
  loadDotEnv();

  const mode = (env('ENS_MODE') ?? 'dev') as Mode;
  if (mode !== 'dev' && mode !== 'live') {
    throw new Error(`env ENS_MODE must be "dev" or "live", got ${JSON.stringify(mode)}`);
  }

  const registryAddress = env('ENS_REGISTRY_ADDRESS') ?? DEFAULT_REGISTRY_ADDRESS;
  if (!isAddress(registryAddress)) {
    throw new Error(`env ENS_REGISTRY_ADDRESS is not an address: ${JSON.stringify(registryAddress)}`);
  }

  const parentName = env('ENS_PARENT_NAME');
  if (parentName !== undefined && !isValidName(parentName)) {
    throw new Error(`env ENS_PARENT_NAME is not a valid ENS name: ${JSON.stringify(parentName)}`);
  }

  const resolverAddress = env('ENS_RESOLVER_ADDRESS');
  if (resolverAddress !== undefined && !isAddress(resolverAddress)) {
    throw new Error(`env ENS_RESOLVER_ADDRESS is not an address: ${JSON.stringify(resolverAddress)}`);
  }

  const hederaNetwork = env('HEDERA_NETWORK') ?? 'hedera:testnet';

  const inviteTokens = (env('INVITE_TOKENS') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const hcsClaimTopicId = env('HCS_CLAIM_TOPIC_ID');
  if (hcsClaimTopicId !== undefined && !/^0\.0\.\d+$/.test(hcsClaimTopicId)) {
    throw new Error(`env HCS_CLAIM_TOPIC_ID must look like 0.0.12345, got ${JSON.stringify(hcsClaimTopicId)}`);
  }

  return {
    mode,
    port: num('PORT', 8404),
    rpcUrl: env('ENS_RPC_URL'),
    parentName,
    parentOwnerKey: env('ENS_PARENT_OWNER_KEY'),
    registryAddress,
    resolverAddress,
    hederaNetwork,
    hcsClaimTopicId,
    hcsAccountId: env('HCS_ACCOUNT_ID'),
    hcsPrivateKey: env('HCS_PRIVATE_KEY'),
    mirrorNodeUrl: (env('MIRROR_NODE_URL') ?? 'https://testnet.mirrornode.hedera.com').replace(/\/+$/, ''),
    inviteTokens,
    dataDir: env('ENS_DATA_DIR') ?? './data',
  };
}

/**
 * Everything the issuing path needs. Called lazily at issue time (not at boot)
 * so the claim API can still start — and serve /health — before the owner has
 * picked a parent. The error message is the setup documentation.
 */
export function requireIssueConfig(cfg: Config): {
  rpcUrl: string;
  parentName: string;
  parentOwnerKey: string;
  registryAddress: string;
  resolverAddress: string;
} {
  const missing: string[] = [];
  if (!cfg.rpcUrl) missing.push('ENS_RPC_URL');
  if (!cfg.parentName) missing.push('ENS_PARENT_NAME (the owner has not chosen a parent yet)');
  if (!cfg.parentOwnerKey) missing.push('ENS_PARENT_OWNER_KEY');
  if (!cfg.resolverAddress) missing.push('ENS_RESOLVER_ADDRESS');
  if (missing.length > 0) {
    throw new Error(`issuing is not configured — set: ${missing.join(', ')}`);
  }
  return {
    rpcUrl: cfg.rpcUrl as string,
    parentName: (cfg.parentName as string).toLowerCase(),
    parentOwnerKey: cfg.parentOwnerKey as string,
    registryAddress: cfg.registryAddress,
    resolverAddress: cfg.resolverAddress as string,
  };
}
