# btcUSD Development Log

## Session 1 — March 5, 2026

### Phase 1 Complete: Smart Contracts

**Starting Point:** Template CRE workflow (`my-workflow/`) running supply APY rebalancing simulation. This was scaffolded from `multi-chain-token-manager` template.

**Goal:** Transform into btcUSD — Bitcoin-backed stablecoin with CRE attestation bridge.

---

### Foundry Setup

```bash
cd contracts
forge init --force
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install smartcontractkit/ccip --no-git
```

**Remappings configured in `foundry.toml`:**
```toml
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@chainlink/contracts-ccip/=lib/ccip/contracts/",
    "forge-std/=lib/forge-std/src/",
]
```

---

### Contracts Created

| Contract | File | Purpose |
|----------|------|---------|
| **BtcUSD** | `src/btcUSD.sol` | ERC20 stablecoin. Only CDPCore can mint/burn via `onlyCDPCore` modifier. |
| **CDPCore** | `src/CDPCore.sol` | Core CDP logic. Accepts CRE attestations, tracks vaults, gates minting. |
| **CCIPSender** | `src/CCIPSender.sol` | Propagates vault state to destination chains via CCIP. |
| **CCIPReceiverVault** | `src/CCIPReceiver.sol` | Receives vault state on destination chains, allows local minting. |

---

### CDPCore Key Features

**Structs:**
```solidity
struct VaultAttestation {
    bytes32 txid;           // Bitcoin txid
    uint64 amountSat;       // BTC in satoshis
    uint32 blockHeight;     // Confirmation block
    uint256 btcPriceUSD;    // 8-decimal price from Chainlink
    uint256 timestamp;      // Attestation time
    address depositor;      // EVM address
}

struct Vault {
    uint256 collateralSat;  // Total attested BTC
    uint256 debtUSD;        // Minted btcUSD (18 decimals)
    uint256 lastAttested;   // Timestamp of last CRE report
    uint256 lastBtcPrice;   // Last attested price
    bool active;
}
```

**Key Functions:**
- `onReport(metadata, report)` — Called by Keystone Forwarder with signed CRE attestation
- `mintBTCUSD(amountUSD)` — Mint against collateral, enforces 150% MCR and 15-min staleness
- `repay(amountUSD)` — Burn btcUSD to reduce debt
- `liquidate(user)` — Seize vault if health factor < 100
- `healthFactor(user)` — Returns health (100 = at MCR, >100 = safe)

**Safety Checks:**
- `onlyKeystone` modifier validates msg.sender
- `attestedTxids` mapping prevents double-attestation
- Staleness check: `block.timestamp - vault.lastAttested > 15 minutes` blocks minting

---

### CCIP Integration

**CCIPSender (Base Sepolia):**
- Called after successful attestation
- Encodes `VaultState` struct and sends via CCIP Router
- Pays fees in LINK token

**CCIPReceiverVault (Arbitrum/Optimism Sepolia):**
- Validates source chain and sender address
- Decodes `VaultState` and updates local vault mapping
- Implements same `mintBTCUSD()` / `repay()` functions

---

### Build Status

```bash
forge build
# Compiler run successful!
```

All contracts compile with Solidity 0.8.24. Only linting notes (naming conventions), no errors.

---

### Multichain Architecture — REFERENCE ANALYSIS

Reviewed the official CRE templates to understand how multichain should work:

---

#### Pattern 1: `multi-chain-token-manager`

This template **moves actual tokens** between chains:

```
Workflow reads APYs from pools on Chain A and Chain B
  ↓
If Chain B has better APY:
  1. Withdraw tokens from Pool A
  2. Send tokens via CCIP to Chain B (actual token transfer)
  3. ProtocolSmartWallet on Chain B receives tokens
  4. Deposit tokens into Pool B
```

**Key insight:** The ProtocolSmartWallet is both a CRE report receiver AND a CCIP receiver. Tokens physically move cross-chain.

---

#### Pattern 2: `stablecoin-ace-ccip`

This template uses **burn-and-mint bridging**:

```
MintingConsumer (Base) receives CRE report → mints stablecoin
  ↓
CCIPTransferConsumer handles cross-chain transfers:
  1. Pull tokens from sender
  2. Approve CCIP Router
  3. Router.ccipSend() → burns tokens on source chain
  4. CCIP delivers message to destination chain
  5. TokenPool on destination mints tokens
```

**Key insight:** The `StablecoinERC20` implements `IBurnMintERC20` interface for CCIP TokenPool compatibility. CCIP Router + TokenPools handle the burn/mint mechanics automatically.

---

#### Correct Pattern for btcUSD

Based on reference templates, the RIGHT architecture is:

```
Base Sepolia (PRIMARY CHAIN - Source of Truth)
├── CDPCore.sol — receives CRE attestations, tracks ALL debt
├── btcUSD.sol — ERC20 with burn/mint for CCIP compatibility
├── User mints/repays HERE ONLY
└── CCIP TokenPool registered for burn-and-mint bridging

Arbitrum Sepolia / Optimism Sepolia (SECONDARY CHAINS)
├── btcUSD.sol — same ERC20 deployed (or bridged representation)
├── CCIP TokenPool for receiving bridged btcUSD
└── NO CDP logic, NO minting — just hold/transfer bridged tokens
```

**The key difference from my initial design:**
- **OLD (wrong):** Propagate vault STATE, allow minting on each chain → leads to undercollateralization
- **NEW (correct):** Mint only on Base, bridge TOKENS via CCIP burn-and-mint → debt stays unified

This matches how real stablecoins work (USDC mints on one chain, bridges to others).

---

#### Contract Changes Needed

1. **Keep `CDPCore.sol`** — Base-only, no CCIP state propagation needed
2. **Update `btcUSD.sol`** — add `IBurnMintERC20` interface for CCIP TokenPool compatibility
3. **DELETE `CCIPSender.sol`** — not needed (CCIP Router handles bridging directly)
4. **DELETE `CCIPReceiver.sol`** — not needed (TokenPool handles minting on destination)
5. **Configure CCIP TokenPools** — register btcUSD with CCIP for cross-chain bridging

---

#### How User Bridges btcUSD

```
User has 1000 btcUSD on Base, wants it on Arbitrum:
  1. User approves CCIP Router to spend btcUSD
  2. User calls Router.ccipSend(arbitrumSelector, message with 1000 btcUSD)
  3. Router pulls 1000 btcUSD from user
  4. BurnMintTokenPool burns 1000 btcUSD on Base
  5. CCIP message sent to Arbitrum (~10-20 min)
  6. BurnMintTokenPool on Arbitrum mints 1000 btcUSD to user
```

No custom contracts needed for bridging — CCIP handles it if btcUSD implements `IBurnMintERC20`.

---

### Contract Simplification Applied

Based on reference template analysis, simplified the architecture:

**Changes Made:**
1. ✅ Updated `btcUSD.sol` with `IBurnMintERC20` interface for CCIP TokenPool compatibility
2. ✅ Deleted `CCIPSender.sol` — not needed, CCIP Router handles bridging
3. ✅ Deleted `CCIPReceiver.sol` — not needed, TokenPool handles minting
4. ✅ Updated `CDPCore.sol` to use `burnFrom()` instead of `burn(from, amount)`

**Final Contract Set:**
- `btcUSD.sol` — ERC20 + IBurnMintERC20 for CCIP compatibility
- `CDPCore.sol` — Core CDP logic, CRE report handler

**Build Status:** ✅ `forge build --skip test --skip script` passes

---

### Next Steps

- [ ] **Phase 1e:** Deploy contracts to Base Sepolia
- [ ] **Phase 2:** Transform CRE workflow from APY rebalancer to Bitcoin attestation
  - Replace mock pool reads with Blockstream API calls
  - Add BTC/USD price feed read
  - Encode VaultAttestation struct
  - Write to CDPCore
- [ ] **Phase 3:** Configure CCIP TokenPools for btcUSD bridging (optional for hackathon)
- [ ] **Phase 4:** Simulation + demo prep
- [ ] **Phase 5:** README, video, submit

---

### File Structure After Simplification

```
bitcoin-backed/
├── contracts/
│   ├── src/
│   │   ├── btcUSD.sol          ✓ ERC20 + IBurnMintERC20 for CCIP
│   │   └── CDPCore.sol         ✓ Core CDP + CRE report handler
│   ├── abi/                    (legacy mock ABIs from template)
│   ├── lib/
│   │   ├── forge-std/
│   │   ├── openzeppelin-contracts/
│   │   └── ccip/
│   └── foundry.toml            ✓ Configured with remappings
├── my-workflow/                (template workflow, needs transformation)
│   ├── main.ts
│   ├── config.json
│   └── workflow.yaml
├── IMPLEMENTATION.md           (full implementation plan)
├── PROJECT.md                  (project overview)
└── LOG.md                      ✓ This file
```

---

### Linting Fixes Applied

**Changes Made:**

1. **btcUSD.sol:**
   - Renamed `s_minters` → `_minters` (standard underscore prefix for private vars)
   - Renamed `s_burners` → `_burners`
   - Wrapped modifier logic in internal functions for gas optimization:
     ```solidity
     function _checkMinter() internal view {
         if (!_minters[msg.sender]) revert OnlyMinter();
     }

     modifier onlyMinter() {
         _checkMinter();
         _;
     }
     ```

2. **CDPCore.sol:**
   - Wrapped `onlyKeystone` modifier logic in `_checkKeystone()` internal function

**Remaining Notes (Intentional):**
- Mixed-case warnings for `btcUSD`, `amountUSD`, `btcPriceUSD` etc. are intentional
- Using all-caps abbreviations (USD, BTC) is standard in crypto/DeFi for clarity

---

### Base-Only CDP Architecture — What It Means

With CDP logic only on Base Sepolia, here's what users can/cannot do:

**On Base Sepolia (PRIMARY):**
- ✅ Deposit BTC collateral (via CRE attestation)
- ✅ Mint btcUSD against collateral
- ✅ Repay debt and reduce position
- ✅ Get liquidated if undercollateralized
- ✅ Check health factor
- ✅ Bridge btcUSD to other chains via CCIP

**On Arbitrum/Optimism Sepolia (SECONDARY):**
- ✅ Receive btcUSD via CCIP bridge
- ✅ Transfer/spend btcUSD freely
- ✅ Use btcUSD in DeFi (LP, lending, swaps)
- ✅ Send btcUSD back to Base via CCIP
- ❌ Cannot mint new btcUSD (no CDPCore)
- ❌ Cannot repay debt (no debt tracking)
- ❌ Cannot deposit BTC collateral
- ❌ Cannot be liquidated

**Key Insight:** btcUSD on secondary chains is just a bridged token — all collateral/debt management must happen on Base.

---

## Session 2 — March 5, 2026

### Phase 2 Complete: CRE Workflow

Transformed the APY rebalancer template into a Bitcoin attestation workflow for btcUSD.

---

### Workflow Structure

```
btcusd-workflow/
├── main.ts                    ✓ Bitcoin attestation workflow
├── config.json                ✓ Base Sepolia config (placeholder addresses)
├── workflow.yaml              ✓ Staging/production targets
├── package.json               ✓ Dependencies configured
└── contracts/abi/
    ├── CDPCore.ts             ✓ ABI for isAttested(), getVault()
    ├── PriceFeedAggregator.ts ✓ ABI for latestAnswer()
    └── index.ts               ✓ Exports
```

---

### Workflow Flow

```
Every 2 minutes (Cron trigger):
  1. Fetch UTXOs from Blockstream API (testnet)
     GET https://blockstream.info/testnet/api/address/{vault}/utxo

  2. Filter confirmed UTXOs (6+ confirmations)
     - Check status.confirmed == true
     - Calculate confirmations from current block height

  3. DON Consensus on external data
     - consensusIdenticalAggregation ensures all nodes agree

  4. Check if already attested
     - evmClient.callContract(CDPCore.isAttested(txid))
     - Skip already-processed UTXOs

  5. Read BTC/USD price from Chainlink
     - evmClient.callContract(PriceFeedAggregator.latestAnswer())
     - Base Sepolia feed: 0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298

  6. Encode VaultAttestation struct
     - encodeAbiParameters(txid, amountSat, blockHeight, btcPriceUsd, timestamp, depositor)

  7. Generate DON-signed report
     - runtime.report() with EVM encoder + ECDSA signing

  8. Submit to CDPCore
     - evmClient.writeReport() via Keystone Forwarder
```

---

### Key Implementation Details

**Blockstream API Integration:**
```typescript
const fetchBlockstreamUTXOs = (sendRequester, vaultAddress) => {
  const url = `https://blockstream.info/testnet/api/address/${vaultAddress}/utxo`
  const resp = sendRequester.sendRequest({ url, method: 'GET' }).result()
  return json(resp) as BlockstreamUTXO[]
}
```

**DON Consensus on External Data:**
```typescript
const utxosJson = httpClient
  .sendRequest(runtime, fetchUTXOsForConsensus, consensusIdenticalAggregation<string>())(config)
  .result()
```

**Chainlink Price Feed Read:**
```typescript
const readBtcUsdPrice = (runtime, evmClient) => {
  const callData = encodeFunctionData({
    abi: PriceFeedAggregator,
    functionName: 'latestAnswer',
  })
  const resp = evmClient.callContract(runtime, { ... }).result()
  return decodeFunctionResult({ abi: PriceFeedAggregator, ... })
}
```

---

### Simulation Test

```bash
cre workflow simulate ./btcusd-workflow --target staging-settings
```

**Output:**
```
✓ Workflow compiled
[SIMULATION] Simulator Initialized
[SIMULATION] Running trigger trigger=cron-trigger@1.0.0
[USER LOG] === btcUSD Bitcoin Attestation Workflow ===
[USER LOG] Vault address: tb1qexamplebitcoinvaultaddress
[USER LOG] Min confirmations: 6
[USER LOG] Fetching UTXOs from Blockstream API...
```

Workflow compiles and triggers correctly. API call fails on placeholder address — expected until real testnet addresses configured.

---

### Next Steps

- [x] **Phase 2:** CRE workflow complete
- [ ] **Phase 1e:** Deploy contracts to Base Sepolia
- [ ] Update config.json with deployed addresses
- [ ] Create Bitcoin testnet vault + fund with testnet BTC
- [ ] Run full simulation with real addresses
- [ ] **Phase 4:** Demo prep + video
- [ ] **Phase 5:** README, submission
