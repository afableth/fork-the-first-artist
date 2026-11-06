/**
 * ENS issuing — the core of this module.
 *
 * One artist = one subname of the owner-supplied parent. The parent owner
 * wallet runs `Registry.setSubnodeRecord` with the **artist's own address as
 * the new owner** (artist controls their name; OSO is not the owner), then the
 * same wallet writes the resolver records the rest of the stack reads:
 *
 * | record                | value                                          |
 * |-----------------------|------------------------------------------------|
 * | `addr`                | the artist's payout wallet (EVM address)       |
 * | `url`                 | profile page URL                               |
 * | `avatar`              | profile image URL                              |
 * | `com.hedera.account`  | Hedera payout account ID (custom text key)     |
 * | `agent.url`           | steward agent URL (x402 endpoint)              |
 * | `vnd.fork-first.claim`| HCS claim transaction id — link to the audit proof |
 *
 * The `Issuer` interface is deliberately narrow (one method, no ethers types)
 * so tests can drive the whole claim flow with a fake without touching a
 * network. `createChainIssuer` is the real implementation.
 */
import { Contract, JsonRpcProvider, Wallet, id, isAddress, namehash, ZeroAddress as zeroAddress } from 'ethers';
import { requireIssueConfig, type Config } from './config.ts';

const REGISTRY_ABI = [
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
  'function setSubnodeRecord(bytes32 parentNode, bytes32 label, address owner, address resolver, uint64 ttl)',
];

const RESOLVER_ABI = [
  'function setAddr(bytes32 node, address addr)',
  'function setText(bytes32 node, string key, string value)',
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
];

/** The text record keys this project writes at issue time. Plan §1. */
export const TEXT_KEYS = {
  profileUrl: 'url',
  avatar: 'avatar',
  hederaAccount: 'com.hedera.account',
  agentUrl: 'agent.url',
  claim: 'vnd.fork-first.claim',
} as const;

export interface NameRecords {
  profileUrl?: string;
  avatar?: string;
  hederaAccount?: string;
  agentUrl?: string;
  /** HCS claim transaction id, the link from the name back to the audit log */
  claimTx?: string;
}

/** Normalize + validate one label (`shaka`, never `Shaka's Band!`). Returns lowercase. */
export function normalizeLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) {
    throw new Error(
      `INVALID_LABEL: ${JSON.stringify(label)} — use 1-63 chars: lowercase letters, digits, hyphens, no leading/trailing hyphen`,
    );
  }
  return l;
}

/** keccak256 of the UTF-8 label bytes — the registry's second argument. */
export function labelHash(label: string): string {
  return id(normalizeLabel(label));
}

/**
 * The exact string the artist signs. Plan §3: "I am [name], claiming
 * [name].<parent>". The frontend must request a signature over precisely this,
 * so it lives here — the one place both sides can point at.
 */
export function claimMessage(label: string, parentName: string): string {
  return `I am ${normalizeLabel(label)}, claiming ${normalizeLabel(label)}.${parentName.toLowerCase()}`;
}

export interface IssueInput {
  /** the requested subname label, e.g. `shaka` for `shaka.<parent>` */
  label: string;
  /** the artist's own wallet — becomes the name's owner */
  owner: string;
  records?: NameRecords;
}

export interface IssueResult {
  name: string;
  node: string;
  owner: string;
  /** registry tx hash; `null` when the subnode already pointed at this owner (repair path) */
  registryTxHash: string | null;
  /** one hash per resolver write (setAddr + one per text record) */
  resolverTxHashes: string[];
  /** the records actually written */
  records: { key: string; value: string }[];
}

export interface Issuer {
  /** the parent name this issuer works under, e.g. `oso.eth` */
  readonly parentName: string;
  issue(input: IssueInput): Promise<IssueResult>;
}

/** Text records with a value, in a stable write order. */
export function recordTuples(records: NameRecords | undefined): { key: string; value: string }[] {
  const r = records ?? {};
  const tuples: { key: string; value: string }[] = [];
  for (const [field, key] of Object.entries(TEXT_KEYS)) {
    const value = (r as Record<string, string | undefined>)[field];
    if (value && value.trim()) tuples.push({ key, value });
  }
  return tuples;
}

/** Real issuer: the parent-owner wallet signs everything on the configured chain. */
export function createChainIssuer(cfg: Config): Issuer {
  const c = requireIssueConfig(cfg); // throws a setup-naming error if incomplete
  const provider = new JsonRpcProvider(c.rpcUrl);
  const wallet = new Wallet(c.parentOwnerKey, provider);
  const registry = new Contract(c.registryAddress, REGISTRY_ABI, wallet);

  return {
    parentName: c.parentName,
    async issue(input: IssueInput): Promise<IssueResult> {
      if (!isAddress(input.owner)) throw new Error(`INVALID_OWNER: not an address: ${JSON.stringify(input.owner)}`);
      const label = normalizeLabel(input.label);
      const name = `${label}.${c.parentName}`;
      const parentNode = namehash(c.parentName);
      const node = namehash(name);

      // Refuse to take a name away from someone else. If the same wallet already
      // owns it, this is a repair path: skip the registry write, still refresh records.
      const current = (await registry.owner(node)) as string;
      const registryTxHash = await (async () => {
        if (current !== zeroAddress && current.toLowerCase() !== input.owner.toLowerCase()) {
          throw new Error(`NAME_TAKEN: ${name} is already owned by ${current}`);
        }
        if (current.toLowerCase() === input.owner.toLowerCase()) return null;
        const tx = await registry.setSubnodeRecord(parentNode, labelHash(label), input.owner, c.resolverAddress, 0);
        const receipt = await tx.wait();
        return receipt?.hash ?? tx.hash;
      })();

      // Records live in the resolver, written by the same wallet. The claim tx
      // (when known) links the name back to the HCS audit proof.
      const resolver = new Contract(c.resolverAddress, RESOLVER_ABI, wallet);
      const resolverTxHashes: string[] = [];
      const setAddrTx = await resolver.setAddr(node, input.owner);
      resolverTxHashes.push((await setAddrTx.wait())?.hash ?? setAddrTx.hash);
      const records: { key: string; value: string }[] = [];
      for (const { key, value } of recordTuples(input.records)) {
        const tx = await resolver.setText(node, key, value);
        resolverTxHashes.push((await tx.wait())?.hash ?? tx.hash);
        records.push({ key, value });
      }

      return { name, node, owner: input.owner, registryTxHash, resolverTxHashes, records };
    },
  };
}

/**
 * Read-only resolution check — what the demo screen (and `npm run resolve`)
 * uses to prove a name actually resolves: registry owner + resolver + the
 * records the project wrote. Read-only, so it needs no key.
 */
export async function readName(
  cfg: Config,
  name: string,
): Promise<{
  name: string;
  node: string;
  owner: string | null;
  resolver: string | null;
  addr: string | null;
  records: Record<string, string>;
}> {
  if (!cfg.rpcUrl) throw new Error('ENS_RPC_URL is not configured');
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const registry = new Contract(cfg.registryAddress, REGISTRY_ABI, provider);
  const node = namehash(name.toLowerCase());
  const owner = (await registry.owner(node)) as string;
  if (owner === zeroAddress) {
    return { name, node, owner: null, resolver: null, addr: null, records: {} };
  }
  const resolverAddress = (await registry.resolver(node)) as string;
  if (resolverAddress === zeroAddress) {
    return { name, node, owner, resolver: null, addr: null, records: {} };
  }
  const resolver = new Contract(resolverAddress, RESOLVER_ABI, provider);
  const addr = (await resolver.addr(node)) as string;
  const records: Record<string, string> = {};
  for (const key of Object.values(TEXT_KEYS)) {
    records[key] = (await resolver.text(node, key)) as string;
  }
  return { name, node, owner, resolver: resolverAddress, addr, records };
}
