# btcUSD — Bitcoin-Backed Stablecoin with Chainlink CRE

A Bitcoin-collateralized stablecoin using Chainlink CRE (Chainlink Runtime Environment) for trustless Bitcoin deposit attestation and Chainlink Price Feeds for BTC/USD pricing.

## Overview

btcUSD enables users to deposit Bitcoin on the Bitcoin network and mint USD-pegged stablecoins on EVM chains. The system uses Chainlink's decentralized oracle network to verify Bitcoin deposits and price collateral.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Bitcoin       │     │  Chainlink CRE  │     │   Base Sepolia  │
│   Testnet4      │────▶│  (DON Consensus)│────▶│   (CDPCore)     │
│                 │     │                 │     │                 │
│ User deposits   │     │ Attests UTXOs   │     │ Mints btcUSD    │
│ BTC to vault    │     │ + BTC/USD price │     │ against collat  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Chainlink Integration

This project uses three Chainlink services:

| Service | Purpose | File |
|---------|---------|------|
| **Chainlink CRE** | Bitcoin attestation workflow | [`btcusd-workflow/main.ts`](btcusd-workflow/main.ts) |
| **Chainlink Price Feeds** | BTC/USD oracle | [`btcusd-workflow/main.ts:170-199`](btcusd-workflow/main.ts#L170-L199) |
| **Chainlink CCIP** | Cross-chain btcUSD bridging (ready) | [`contracts/src/btcUSD.sol`](contracts/src/btcUSD.sol) |

### Files Using Chainlink

| File | Chainlink Usage |
|------|-----------------|
| [`btcusd-workflow/main.ts`](btcusd-workflow/main.ts) | CRE workflow, HTTPClient, EVMClient, consensusIdenticalAggregation, Price Feed read |
| [`btcusd-workflow/contracts/abi/PriceFeedAggregator.ts`](btcusd-workflow/contracts/abi/PriceFeedAggregator.ts) | Chainlink Price Feed ABI |
| [`contracts/src/btcUSD.sol`](contracts/src/btcUSD.sol) | IBurnMintERC20 interface for CCIP TokenPool compatibility |
| [`contracts/src/CDPCore.sol`](contracts/src/CDPCore.sol) | Receives CRE attestations via Keystone Forwarder |
| [`contracts/script/ConfigureCDPCore.s.sol`](contracts/script/ConfigureCDPCore.s.sol) | Sets Keystone Forwarder address |

## How It Works

### 1. Bitcoin Deposit
User sends BTC to a monitored vault address on Bitcoin Testnet4.

### 2. CRE Attestation
The CRE workflow runs every 2 minutes:
- Fetches UTXOs from mempool.space API
- Verifies 6+ confirmations
- Reads BTC/USD price from Chainlink Price Feeds
- Achieves DON consensus on the data
- Submits signed attestation to CDPCore

### 3. Mint btcUSD
User calls `mintBtcUsd()` on CDPCore to mint stablecoins against their attested collateral (150% minimum collateral ratio).

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| **BtcUSD** | [`0xA5FCD5d200f949F7e78D4c7771F602aa4B0e387A`](https://sepolia.basescan.org/address/0xA5FCD5d200f949F7e78D4c7771F602aa4B0e387A) |
| **CDPCore** | [`0x4F545CE997b7A5fEA9101053596D4834Bc882c7f`](https://sepolia.basescan.org/address/0x4F545CE997b7A5fEA9101053596D4834Bc882c7f) |

## Quick Start

### Prerequisites
- [CRE CLI](https://docs.chain.link/cre)
- [Foundry](https://book.getfoundry.sh/)
- [Bun](https://bun.sh/)

### Run Simulation

```bash
# Install dependencies
bun install --cwd ./btcusd-workflow

# Simulate the workflow
cre workflow simulate ./btcusd-workflow --target staging-settings
```

### Run Demo (End-to-End)

```bash
cd contracts

# Set environment
export CRE_ETH_PRIVATE_KEY="0x<your-private-key>"

# Run demo flow (attests UTXOs + mints btcUSD)
forge script script/DemoFlow.s.sol:DemoFlowScript \
  --rpc-url https://base-sepolia-rpc.publicnode.com \
  --broadcast
```

## Security Model & Limitations

### Current Implementation (v1 - Hackathon Demo)

| Aspect | Status | Notes |
|--------|--------|-------|
| Bitcoin attestation | ✅ Working | CRE verifies UTXOs exist |
| Price oracle | ✅ Working | Chainlink BTC/USD feed |
| CDP mechanics | ✅ Working | 150% MCR, liquidation |
| **BTC custody enforcement** | ⚠️ **Not implemented** | See below |

### ⚠️ Important Limitation

**This is a proof-of-concept.** The current design attests that BTC exists at a vault address but does NOT enforce custody:

```
Current Model:
1. User deposits BTC to vault address
2. CRE attests the UTXO exists
3. User mints btcUSD
4. ⚠️ User could move BTC (no on-chain enforcement)
```

**Production implementation would require:**
- P2WSH/P2TR scripts with spending conditions
- DLC-style (Discreet Log Contract) custody
- BitVM or ZK-proof based verification

### Production Roadmap (v2)

For trustless BTC custody, future versions would implement:

1. **DLC-based locking** - BTC locked in 2-of-2 multisig with oracle-signed spending conditions
2. **UTXO monitoring** - CRE detects if collateral UTXOs are spent, triggers liquidation
3. **P2WSH scripts** - Bitcoin-native spending conditions tied to EVM debt state

## Project Structure

```
bitcoin-backed/
├── btcusd-workflow/           # CRE workflow
│   ├── main.ts                # Bitcoin attestation logic
│   ├── config.json            # Vault address, chain config
│   └── contracts/abi/         # CDPCore, PriceFeed ABIs
├── contracts/                 # Solidity contracts
│   ├── src/
│   │   ├── btcUSD.sol         # ERC20 + CCIP compatible
│   │   └── CDPCore.sol        # CDP logic + CRE receiver
│   └── script/
│       ├── Deploy.s.sol       # Deployment script
│       ├── ConfigureCDPCore.s.sol  # Keystone setup
│       └── DemoFlow.s.sol     # End-to-end demo
├── project.yaml               # CRE project config
└── README.md                  # This file
```

## References

- [Chainlink CRE Documentation](https://docs.chain.link/cre)
- [Chainlink Price Feeds](https://docs.chain.link/data-feeds)
- [Chainlink CCIP](https://docs.chain.link/ccip)
- [DLC Specifications](https://github.com/discreetlogcontracts/dlcspecs) - Future custody model

## License

MIT
