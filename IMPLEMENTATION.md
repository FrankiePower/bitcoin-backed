# btcUSD — Implementation Plan
**Track:** DeFi & Tokenization | **Deadline:** March 8

---

## Architecture Overview

```
Bitcoin Testnet
  └─ Vault address (P2WPKH) — user sends BTC here

CRE Workflow (Cron, every 2 min)
  ├─ Blockstream API → fetch confirmed UTXOs (external API ✓)
  ├─ ConsensusAggregationByFields → DON agrees on deposit data
  ├─ Chainlink BTC/USD Price Feed → collateral valuation (on-chain read)
  └─ runtime.report() + evmClient.writeReport() → CDPCore on Base Sepolia

Base Sepolia (primary chain)
  ├─ CDPCore.sol — processes CRE report, tracks vaults, gates minting
  ├─ btcUSD.sol — ERC20, mint/burn gated to CDPCore
  └─ CCIPSender.sol — propagates vault state via CCIP after attestation

Arbitrum Sepolia + Optimism Sepolia
  └─ CCIPReceiver.sol — receives vault state, allows btcUSD minting there too
```

**Three Chainlink services:**
1. **CRE** — trustless Bitcoin → EVM bridge (irreplaceable)
2. **Chainlink BTC/USD Price Feed** — collateral valuation inside workflow
3. **CCIP** — multichain vault state propagation

---

## Phase 0 — Project Setup

**References:** `demo-workflow/` (existing CRE scaffold), `demo-workflow/package.json`

### Goal
Repo structure, tooling installed, testnet funded, accounts configured.

### Repo Structure
```
btcusd/
├── workflow/           ← CRE workflow (TypeScript)
│   ├── main.ts
│   ├── workflow.yaml
│   ├── config.staging.json
│   └── config.production.json
├── contracts/          ← Solidity (Hardhat or Foundry)
│   ├── btcUSD.sol
│   ├── CDPCore.sol
│   ├── CCIPSender.sol
│   └── CCIPReceiver.sol
├── project.yaml        ← CRE project config
├── secrets.yaml        ← CRE secrets (gitignored)
└── README.md
```

### Todo
- [ ] Create `btcusd/` directory at project root
- [ ] Copy `demo-workflow/` scaffold into `btcusd/workflow/`
- [ ] Install CRE SDK: `npm install @chainlink/cre-sdk`
- [ ] Install viem and zod: `npm install viem zod`
- [ ] Init Hardhat or Foundry in `btcusd/contracts/`
- [ ] Install CCIP contracts: `npm install @chainlink/contracts-ccip`
- [ ] Install OpenZeppelin: `npm install @openzeppelin/contracts`
- [ ] Fund a wallet on Base Sepolia, Arbitrum Sepolia, Optimism Sepolia (testnet faucets)
- [ ] Get free Blockstream API access (no key needed — public API)
- [ ] Set up `secrets.yaml` for CRE (wallet private key, RPC URLs)
- [ ] Configure `project.yaml` with Base Sepolia RPC

---

## Phase 1 — Smart Contracts

**References:**
- `reference/cre-templates/starter-templates/stablecoin-ace-ccip/` — stablecoin + CCIP consumer pattern
- `reference/cre-templates/starter-templates/multi-chain-token-manager/` — multi-chain EVM write pattern

### 1a. `btcUSD.sol`

Simple ERC20. Only CDPCore can mint or burn. Nothing else.

```solidity
// Key interface
function mint(address to, uint256 amount) external onlyCDPCore
function burn(address from, uint256 amount) external onlyCDPCore
```

**Todo:**
- [ ] Write `btcUSD.sol` — ERC20, `onlyCDPCore` modifier, `setCDPCore(address)` owner-only
- [ ] Unit test: mint reverts if caller is not CDPCore
- [ ] Unit test: burn reverts if caller is not CDPCore

---

### 1b. `CDPCore.sol`

The main contract. Accepts signed CRE reports from the Keystone Forwarder. Tracks vault state. Gates minting on collateral health.

```solidity
// Core structs
struct VaultAttestation {
    bytes32 txid;          // Bitcoin txid (first 31 bytes as bytes32)
    uint64  amountSat;     // BTC amount in satoshis
    uint32  blockHeight;   // confirmation block
    uint256 btcPriceUSD;   // 8-decimal price from CRE (via Price Feed)
    uint256 timestamp;     // attestation time
    address depositor;     // EVM address that registered the vault
}

struct Vault {
    uint256 collateralSat; // total attested BTC (satoshis)
    uint256 debtUSD;       // minted btcUSD
    uint256 lastAttested;  // timestamp of last valid CRE report
    bool    active;
}

// Key functions
function processAttestation(bytes calldata report) external onlyKeystone
function mintBTCUSD(uint256 amountUSD) external
function repay(uint256 amountUSD) external
function liquidate(address user) external
function healthFactor(address user) public view returns (uint256)

// Constants
uint256 public constant MCR = 150;           // 150% min collateral ratio
uint256 public constant STALENESS_LIMIT = 15 minutes;
```

**Staleness check (MultiSub pattern):** `mintBTCUSD` reverts if `block.timestamp - vault.lastAttested > STALENESS_LIMIT`. Minting is oracle-gated.

**Health factor formula:** `hf = collateral_usd * 10000 / (debt_usd * MCR)`. >= 100 = safe.

**Todo:**
- [ ] Write `CDPCore.sol` with `processAttestation()` — decodes CRE report, updates vault
- [ ] Add `onlyKeystone` modifier — validates msg.sender is the CRE Keystone Forwarder address
- [ ] Implement `mintBTCUSD()` — checks health factor >= 100, checks staleness, mints via btcUSD
- [ ] Implement `repay()` — burns btcUSD, reduces debt
- [ ] Implement `liquidate()` — callable if hf < 100, seizes collateral record, burns debt
- [ ] Implement `healthFactor()` view — `collateral_usd * 10000 / (debt_usd * MCR)`
- [ ] Register `btcUSD` address via `setStablecoin()`
- [ ] Unit test: attestation from non-Keystone address reverts
- [ ] Unit test: stale attestation blocks minting
- [ ] Unit test: health factor calculation correct
- [ ] Unit test: liquidation only works when hf < 100

---

### 1c. `CCIPSender.sol` (Base Sepolia)

Called by CDPCore after a successful attestation. Sends vault state to destination chains via CCIP so users can mint btcUSD there too.

```solidity
// Called by CDPCore internally after processAttestation succeeds
function propagateVault(
    address depositor,
    uint256 collateralSat,
    uint64  destChainSelector
) external onlyCDPCore
```

**Reference:** `stablecoin-ace-ccip/ccip-transfer-workflow/main.ts` — CCIP encoding pattern.

**Todo:**
- [ ] Write `CCIPSender.sol` — encodes vault state as CCIP message, calls CCIP Router
- [ ] Fund contract with LINK for CCIP fees (or use native gas payment)
- [ ] Unit test: CCIP message encoded correctly

---

### 1d. `CCIPReceiver.sol` (Arbitrum Sepolia + Optimism Sepolia)

Receives vault state from Base via CCIP. Lets users mint btcUSD on destination chains against already-attested collateral.

```solidity
function _ccipReceive(Client.Any2EVMMessage memory message) internal override
// Updates local vault state, allows minting up to attested collateral
```

**Todo:**
- [ ] Write `CCIPReceiver.sol` — inherits `CCIPReceiver` from `@chainlink/contracts-ccip`
- [ ] Decode vault state from CCIP message, update local vault mapping
- [ ] Allow `mintBTCUSD()` on destination chain against received vault state
- [ ] Unit test: only accepts messages from Base Sepolia chain selector

---

### 1e. Deploy

**Todo:**
- [ ] Deploy `btcUSD` on Base Sepolia → save address
- [ ] Deploy `CDPCore` on Base Sepolia → `setCDPCore` on btcUSD
- [ ] Deploy `CCIPSender` on Base Sepolia → wire to CDPCore
- [ ] Deploy `CCIPReceiver` on Arbitrum Sepolia → save address
- [ ] Deploy `CCIPReceiver` on Optimism Sepolia → save address
- [ ] Fund `CCIPSender` with LINK on Base Sepolia
- [ ] Save all addresses to `workflow/config.staging.json`

---

## Phase 2 — CRE Workflow

**References:**
- `reference/cre-templates/building-blocks/indexer-data-fetch/` — cron + HTTP polling pattern
- `reference/cre-templates/starter-templates/bring-your-own-data/workflow-ts/por/main.ts` — `ConsensusAggregationByFields` + `runtime.report()` + `evmClient.writeReport()` — **primary reference**
- `reference/cre-templates/building-blocks/read-data-feeds/` — BTC/USD on-chain price read

### What The Workflow Does

```
Every 2 minutes:
1. GET blockstream.info/testnet/api/address/{VAULT}/utxo
2. Filter: status.confirmed == true && confirmations >= 6
3. ConsensusAggregationByFields:
     median(value)        → agree on sat amount
     identical(txid)      → agree on which tx
     identical(depositor) → agree on who
4. Read BTC/USD Price Feed on-chain (latestAnswer)
5. Encode VaultAttestation struct (txid, amountSat, blockHeight, btcPriceUSD, depositor, timestamp)
6. runtime.report() → DON signs
7. evmClient.writeReport() → CDPCore on Base Sepolia
```

### Key Design Decisions

**Why `ConsensusAggregationByFields`?**
Multiple CRE nodes independently query Blockstream. `median` on `value` (satoshis) means even if one node sees a slightly different mempool state, the DON uses the median. `identical` on `txid` means all nodes must agree on which transaction is being attested. This mirrors exactly what AIMM did for Kalshi prices — and judges rewarded it.

**Why read BTC/USD inside the workflow?**
The workflow writes `btcPriceUSD` into the attestation. CDPCore uses this for collateral valuation without needing a separate price oracle call. One CRE report carries both the Bitcoin proof AND the USD value.

**How to avoid double-attestation?**
Before writing, the workflow calls `CDPCore.isAttested(txid)` via `evmClient.readContract()`. If already attested, skip. No AWS S3 needed.

### `workflow/main.ts` Structure

```typescript
// Imports from bring-your-own-data/por pattern
import { ConsensusAggregationByFields, median, identical, ... } from '@chainlink/cre-sdk'

// Config schema (zod)
const configSchema = z.object({
  schedule: z.string(),            // "*/2 * * * *"
  vaultAddress: z.string(),        // Bitcoin testnet vault address
  cdpCoreAddress: z.string(),      // Base Sepolia CDPCore
  btcUsdFeedAddress: z.string(),   // Chainlink BTC/USD feed on Base Sepolia
  confirmationsRequired: z.number(), // 6
  network: z.object({
    chainName: z.string(),         // "ethereum-testnet-sepolia" or base
    gasLimit: z.string(),
  })
})

// UTXO shape from Blockstream API
interface UTXO {
  txid: string
  value: number           // satoshis
  status: {
    confirmed: boolean
    block_height: number
    block_hash: string
  }
}

// 1. fetchUTXOs — GET blockstream API
// 2. filterConfirmed — confirmations >= 6
// 3. checkAlreadyAttested — evmClient.readContract(CDPCore.isAttested(txid))
// 4. readBTCPrice — evmClient.readContract(priceFeed.latestAnswer())
// 5. ConsensusAggregationByFields on UTXO { value: median, txid: identical }
// 6. encodeVaultAttestation — encodeAbiParameters(...)
// 7. runtime.report() → sign
// 8. evmClient.writeReport() → CDPCore
```

### Todo
- [ ] Write `workflow/main.ts` — cron trigger scaffold (copy from `indexer-data-fetch`)
- [ ] Implement `fetchUTXOs(vaultAddress)` — GET `blockstream.info/testnet/api/address/{addr}/utxo`
- [ ] Implement `filterConfirmed(utxos, minConfirmations)` — filter by `status.confirmed` and block depth
- [ ] Implement `readBTCPrice(evmClient, feedAddress)` — `evmClient.readContract` calling `latestAnswer()`
- [ ] Implement `checkAlreadyAttested(evmClient, txid)` — skip already-processed txids
- [ ] Add `ConsensusAggregationByFields` — `median` for `value`, `identical` for `txid`
- [ ] Implement `encodeVaultAttestation()` — `encodeAbiParameters` with full struct
- [ ] Implement `writeAttestation()` — `runtime.report()` + `evmClient.writeReport()` to CDPCore
- [ ] Write `workflow/config.staging.json` — vault address, contract addresses, schedule
- [ ] Write `workflow/workflow.yaml` — staging + production targets
- [ ] Run `cre simulate` — verify workflow executes without errors

---

## Phase 3 — CCIP Multichain

**References:**
- `reference/cre-templates/starter-templates/stablecoin-ace-ccip/ccip-transfer-workflow/main.ts` — CCIP encoding pattern
- `reference/cre-templates/starter-templates/multi-chain-token-manager/workflow-ts/workflow/main.ts` — multi-chain loop pattern

### Approach

CDPCore calls `CCIPSender.propagateVault()` automatically inside `processAttestation()` after a successful attestation. The CRE workflow only needs to write to Base Sepolia — CCIP handles the rest on-chain. This is cleaner than having the CRE workflow manage CCIP directly.

```
CRE writes to Base Sepolia CDPCore
  → CDPCore processes attestation
  → CDPCore calls CCIPSender
  → CCIPSender sends to Arbitrum Sepolia + Optimism Sepolia
  → CCIPReceivers update vault state on destination chains
```

### Todo
- [ ] Wire `CDPCore.processAttestation()` to call `CCIPSender.propagateVault()` after success
- [ ] Configure `CCIPSender` with destination chain selectors and receiver addresses
- [ ] Fund `CCIPSender` with LINK on Base Sepolia (for CCIP fees)
- [ ] Deploy `CCIPReceiver` on Arbitrum Sepolia — set allowlisted source (Base Sepolia selector + CCIPSender address)
- [ ] Deploy `CCIPReceiver` on Optimism Sepolia — same
- [ ] End-to-end test: deposit BTC → CRE attests → vault state appears on Arbitrum via CCIP

---

## Phase 4 — Simulation & Demo Prep

**References:** CRE CLI docs, `demo-workflow/` for CLI commands

### CRE CLI Simulation

This is the **minimum required** for the hackathon submission. Live deployment is a bonus.

```bash
# From btcusd/workflow/
cre simulate --target staging-settings
```

Simulation must show:
- Cron trigger fires
- Blockstream API call succeeds (use real testnet vault with a small BTC deposit)
- ConsensusAggregationByFields output visible in logs
- BTC/USD price read succeeds
- VaultAttestation encoded
- Report signed by DON
- writeReport submitted to CDPCore

### Todo
- [ ] Fund vault address with a small testnet BTC amount (Bitcoin testnet faucet)
- [ ] Confirm the UTXO appears in Blockstream API response
- [ ] Run `cre simulate` — fix any runtime errors
- [ ] Verify `writeReport` transaction on Base Sepolia Etherscan
- [ ] Verify CCIP message on ccip.chain.link
- [ ] Screen record full simulation (3-5 min) — this is the submission video
- [ ] Record screen with terminal + Etherscan tx confirmation side by side

---

## Phase 5 — Submission

### README Requirements
The README must **link every Chainlink file** — this is an explicit judging requirement.

```markdown
## Chainlink Integration

| Service | File | Purpose |
|---|---|---|
| CRE Workflow | workflow/main.ts | Bitcoin vault monitor + attestation |
| CRE Config | workflow/workflow.yaml | Workflow deployment config |
| Chainlink BTC/USD Price Feed | workflow/main.ts#L42 | Collateral valuation |
| CCIP Sender | contracts/CCIPSender.sol | Cross-chain vault propagation |
| CCIP Receiver | contracts/CCIPReceiver.sol | Destination chain vault state |
| CRE Report Consumer | contracts/CDPCore.sol | Keystone Forwarder report handler |
```

### Todo
- [ ] Write `README.md` — project summary, architecture diagram (Mermaid), Chainlink file table
- [ ] Add Mermaid sequence diagram (BMCP won partly because of this — judges can visually follow the flow)
- [ ] Add decoded example: what a VaultAttestation looks like (raw bytes → decoded fields)
- [ ] Make GitHub repo public
- [ ] Submit 3-5 min video (unlisted YouTube or Loom)
- [ ] DoraHacks / hackathon portal submission

---

## Wow Factors (From Winners — Nothing Forced)

These come directly from what judges rewarded in ETHGlobal Buenos Aires:

| Idea | From | Status | Why |
|---|---|---|---|
| `ConsensusAggregationByFields` with `median`/`identical` per field | AIMM | **Built into Phase 2** | Shows deep CRE knowledge — DON-level Bitcoin UTXO consensus |
| Mermaid sequence diagram in README | BMCP | **Phase 5** | Judges follow the flow visually — BMCP won partly for completeness |
| Oracle-gated minting (staleness check) | MultiSub | **Built into Phase 1** | CDPCore refuses mint if CRE attestation > 15 min old |
| Three Chainlink services composed | BMCP + MultiSub | **Built into architecture** | CRE + Price Feed + CCIP — each load-bearing |
| Decoded example in README | BMCP | **Phase 5** | Shows a real VaultAttestation with actual txid/amount |

---

## Chainlink Services Summary (For README)

| Service | Where Used | Why It's Irreplaceable |
|---|---|---|
| **CRE** | `workflow/main.ts` | Only trustless way to bridge Bitcoin state to EVM. Remove CRE = need a centralized relayer. |
| **Chainlink BTC/USD Price Feed** | `workflow/main.ts` (on-chain read inside workflow) | Collateral valuation at attestation time, embedded in DON-signed report |
| **CCIP** | `CCIPSender.sol`, `CCIPReceiver.sol` | Single BTC deposit unlocks btcUSD on any supported chain. Remove CCIP = single-chain only. |

---

## Order of Operations (5 Days)

```
Day 1: Phase 0 (setup) + Phase 1a/1b (btcUSD + CDPCore contracts)
Day 2: Phase 1c/1d/1e (CCIP contracts + deploy all to testnets)
Day 3: Phase 2 (CRE workflow — core build)
Day 4: Phase 3 (CCIP wiring) + Phase 4 (simulation, fix bugs)
Day 5: Phase 5 (README, video, submit)
```
