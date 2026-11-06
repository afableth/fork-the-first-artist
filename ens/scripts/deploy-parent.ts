/**
 * One-off: register the parent `<label>.eth` through the ETH Registrar
 * Controller (commit → wait out the commitment age → register).
 *
 *   node scripts/deploy-parent.ts --label oso --duration-years 1
 *
 * Plan §5 calls parent registration "fiddly" and this is the honest version of
 * that: the controller contract is deployed per chain, so the address must be
 * confirmed from the official ENS deployments page and set in
 * ENS_CONTROLLER_ADDRESS — no guessed address ships here. Needs a funded
 * Sepolia wallet (ENS_PARENT_OWNER_KEY) and the gas + rent price in ETH.
 *
 *   --check  only prints availability/price/ownership, writes nothing.
 *
 * After registration, issue subnames with scripts/issue.ts or the claim API.
 */
import { randomBytes } from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet, namehash, zeroAddress } from 'ethers';
import { loadConfig } from '../src/config.ts';

const REGISTRY_ABI = ['function owner(bytes32 node) view returns (address)'];

const CONTROLLER_ABI = [
  'function available(string name) view returns (bool)',
  'function rentPrice(string name, uint256 duration) view returns (uint256)',
  'function makeCommitment(string name, address owner, uint256 duration, bytes32 secret, address resolver, address[] data, bool reverseRecord, uint16 ownerControlledFuzz) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, address[] data, bool reverseRecord, uint16 ownerControlledFuzz) payable',
  'function minCommitmentAge() view returns (uint256)',
  'function maxCommitmentAge() view returns (uint256)',
];

const YEAR_SECONDS = 365n * 24n * 3600n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const cfg = loadConfig();
  if (!cfg.rpcUrl || !cfg.parentOwnerKey) {
    console.error('ENS_RPC_URL and ENS_PARENT_OWNER_KEY are required');
    process.exitCode = 1;
    return;
  }
  const controllerAddress = process.env.ENS_CONTROLLER_ADDRESS;
  if (!controllerAddress) {
    console.error(
      'ENS_CONTROLLER_ADDRESS is required — take it from the official ENS deployments page for the target chain. No guessed address is shipped here.',
    );
    process.exitCode = 1;
    return;
  }

  const label = (arg('label') ?? cfg.parentName?.split('.')[0] ?? '').toLowerCase();
  if (!label) {
    console.error('pass --label <label> (or set ENS_PARENT_NAME) — the parent is not chosen yet');
    process.exitCode = 1;
    return;
  }
  const name = `${label}.eth`;
  const duration = BigInt(Number(arg('duration-years') ?? '1') * Number(YEAR_SECONDS));

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.parentOwnerKey, provider);
  const registry = new Contract(cfg.registryAddress, REGISTRY_ABI, wallet);
  const controller = new Contract(controllerAddress, CONTROLLER_ABI, wallet);
  const node = namehash(name);

  const owner = (await registry.owner(node)) as string;
  console.log(`parent: ${name}`);
  console.log(`owner:  ${owner === zeroAddress ? 'unregistered' : owner}`);
  if (owner !== zeroAddress) {
    if (owner.toLowerCase() === wallet.address.toLowerCase()) {
      console.log('already owned by the configured wallet — nothing to register; run issue.ts next');
    } else {
      console.error('already owned by someone else — pick another parent or stop');
      process.exitCode = 1;
    }
    return;
  }
  if (!(await controller.available(label)) as boolean) {
    console.error(`${label}.eth is not available on the registrar`);
    process.exitCode = 1;
    return;
  }
  const price = (await controller.rentPrice(label, duration)) as bigint;
  console.log(`rent:   ${Number(price) / 1e18} ETH for ${Number(duration) / Number(YEAR_SECONDS)} year(s)`);
  const balance = await provider.getBalance(wallet.address);
  if (balance < price) {
    console.error(`wallet balance ${(Number(balance) / 1e18).toFixed(6)} ETH is below the rent price — fund it first`);
    process.exitCode = 1;
    return;
  }
  if (checkOnly) return;

  // ── commit ────────────────────────────────────────────────────────────────
  const secret = `0x${randomBytes(32).toString('hex')}`;
  const commitment = (await controller.makeCommitment(
    label,
    wallet.address,
    duration,
    secret,
    zeroAddress, // resolver: set later by issue.ts
    [],
    false,
    0,
  )) as string;
  const commitTx = await controller.commit(commitment);
  const commitReceipt = await commitTx.wait();
  const committedAt = (await provider.getBlock(commitReceipt!.blockNumber))!.timestamp;
  console.log(`committed ${commitment} in ${commitReceipt!.hash}`);

  // ── wait out the commitment age ───────────────────────────────────────────
  const minAge = Number(await controller.minCommitmentAge());
  const readyAt = (committedAt + minAge) * 1000;
  console.log(`waiting out the commitment age (${minAge}s)…`);
  while (Date.now() < readyAt) {
    await sleep(Math.min(5000, readyAt - Date.now()));
  }

  // ── register ──────────────────────────────────────────────────────────────
  const registerTx = await controller.register(
    label,
    wallet.address,
    duration,
    secret,
    zeroAddress,
    [],
    false,
    0,
    { value: price },
  );
  const receipt = await registerTx.wait();
  console.log(`registered in ${receipt!.hash}`);
  const newOwner = (await registry.owner(node)) as string;
  if (newOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`post-check failed: registry owner is ${newOwner}, expected ${wallet.address}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${name} is owned by ${wallet.address} — set ENS_PARENT_NAME=${name} and start issuing.`);
  console.log('reminder: expiry/renewal policy is a documented decision, not an automatic one — record it in the README.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
