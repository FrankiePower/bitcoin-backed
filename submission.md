# Convergence Hackathon Submission

## Project

- **Name**: btcUSD — Bitcoin-Backed Stablecoin with Chainlink CRE
- **Repo**: https://github.com/FrankiePower/bitcoin-backed
- **Primary track**: DeFi & Tokenization
- **Chainlink technologies**: CRE, Data Feeds (BTC/USD)

---

## One-Line Pitch

A Bitcoin-collateralized stablecoin where BTC deposits are verified by Chainlink CRE's DON and minting happens on any EVM chain — no custodian, no trusted bridge operator.

---

## Problem

BTC-backed stablecoins (WBTC, tBTC, etc.) all rely on some form of trusted custody or bridge committee. This creates single points of failure: custodian insolvency, censorship, and counterparty risk. Native Bitcoin has no smart contract capability, so bringing it into DeFi trustlessly is an open problem.

---

## Solution

btcUSD uses Chainlink CRE as the decentralized verification layer between Bitcoin and EVM:

1. User deposits BTC to a monitored vault address on Bitcoin Testnet4
2. A CRE workflow running on a DON fetches confirmed UTXOs from mempool.space
3. The DON reaches consensus and produces a signed attestation report
4. The report is delivered to `CDPCore` on the configured EVM chain via the Keystone Forwarder
5. `CDPCore` updates the user's collateral and auto-mints `btcUSD` at 150% MCR
6. If BTC is later spent out of the vault, a snapshot report reduces collateral on-chain
7. Health factor drops below 100 → vault is flagged for liquidation by the next cron run

**Multi-chain by design**: deploying `CDPCore` + `btcUSD` on any EVM chain and pointing the CRE workflow `config.json` at it is all that's needed to mint on that chain. No bridge required.

---

## How We Used CRE

### Capabilities used
| Capability | Usage |
|-----------|-------|
| HTTP | Fetch confirmed UTXOs from `mempool.space/testnet4/api` |
| EVM read | Read BTC/USD price from Chainlink Data Feed on Base Sepolia |
| EVM read | Read vault health factor from CDPCore |
| EVM write | Submit signed attestation report via `writeReport` → Keystone Forwarder → CDPCore |
| Cron trigger | Runs every 2 minutes to check deposits and vault health |

### Three report formats implemented in CDPCore
- **V1** (192 bytes): Standard attestation — `txid, amountSat, blockHeight, btcPriceUsd, timestamp, depositor`
- **V2** (224 bytes): V1 + `mintAmountUsd` — workflow requests auto-mint in the same report
- **V3 Snapshot** (256 bytes): Authoritative collateral sync — `reportKind, depositor, collateralSat, btcPriceUsd, timestamp, mintAmountUsd, reserved, version`

### Liquidation detection
Every cron run the workflow computes `healthFactor = (collateralUsd * 10000) / (debtUsd * MCR)`. If `healthFactor < 100`, the vault is undercollateralized and flagged `isLiquidatable: true`.

### Core workflow file
`btcusd-workflow/main.ts`

---

## Architecture

```
Bitcoin Testnet4                    Chainlink CRE DON
┌──────────────┐    mempool.space   ┌─────────────────────────┐
│  BTC Vault   │ ──── UTXOs ──────► │  btcUSD CRE Workflow    │
│  tb1qvwgj... │                    │  - Fetch UTXOs (HTTP)   │
└──────────────┘                    │  - Read BTC/USD (EVM)   │
                                    │  - Build V2 report      │
                                    │  - Submit snapshot      │
                                    │  - Check health factor  │
                                    └────────┬────────────────┘
                                             │ signed report
                                    ┌────────▼────────────────┐
                                    │  Keystone Forwarder     │
                                    │  (Base Sepolia)         │
                                    └────────┬────────────────┘
                                             │ onReport()
                     ┌───────────────────────▼──────────────────┐
                     │  CDPCore (Base Sepolia)                   │
                     │  - Verify forwarder + workflow owner      │
                     │  - Decode V1/V2/V3 report format          │
                     │  - Update collateralSat                   │
                     │  - Auto-mint btcUSD up to MCR capacity    │
                     │  - Flag liquidatable vaults               │
                     └───────────────────┬──────────────────────┘
                                         │ mint/burn
                     ┌───────────────────▼──────────────────────┐
                     │  btcUSD ERC-20 (Base Sepolia)            │
                     └──────────────────────────────────────────┘
```

---

## Live Testnet Evidence

### Contracts (Base Sepolia)
| Contract | Address |
|----------|---------|
| BtcUSD | `0x5a458544342eEaA64BB6b9940F826cbd74d62D8E` |
| CDPCore | `0x25cb5d05f22f218818Bd950969fCd6Ba0E196FaC` |

### Deployment transactions
- BtcUSD deploy: `0x6830aeb1f52b11bfb13002ddeafd8047b2e11b5b5f2f5363134dbc0f73919873`
- CDPCore deploy: `0x99dcafd03770340a04133ec19bab86beba48f303514ef31e1049b43afef25584`

### Demo flow transactions (deposit → mint → liquidation)
- Attest UTXO 1 (V1 report): `0x39a2803796b25b8ca5f21f33fef7387b0ef51461a607f83afbcd2c1fe64a215a`
- Attest UTXO 2 (V1 report): `0xc18c27662f047fc2083fb063e88a312edd78591bb054b23776cfa29e4dae60b6`
- Mint btcUSD: `0xf3f213165faf53ac2dc4a5239f25fafdf15416140382a0deef21aff535e979bc`
- Snapshot (0 collateral → liquidatable): `0xad397f82a708c4f98c75e0eb71f923742ea82bc7dc7e48b69de1047a9e91d4fa`

### Bitcoin Testnet4
- BTC Vault: `tb1qvwgjgrxvq3nztnz5tpwquxx30ps66vcx0jl7lh`
- Funding deposit: `d18cbd5815cde5454be780a5a3652c0107f64ee46f3025239cb59a22f655b0af`
- Vault sweep (liquidation trigger): `4c58b598fa1dd3b172f72519923a26557dc5c12bf06507625d93018bd5ac30a6`

### CRE Simulation
```bash
cre workflow simulate ./btcusd-workflow --target staging-settings
```

---

## Key Design Decisions

- **No oracle committee**: CRE DON consensus replaces a trusted multisig for attestation
- **Report versioning**: V1/V2/V3 detected by byte length, enabling backward-compatible upgrades
- **Auto-mint via report**: Workflow can request minting in the same tx as attestation (V2), reducing user friction
- **Snapshot sync**: V3 reports let the workflow authoritatively reduce collateral when UTXOs are spent, enabling on-chain liquidation detection without any user action
- **Multi-chain**: The workflow `config.json` specifies `chainName` + `cdpCoreAddress` — deploying on a new chain requires no code changes, just a new config pointing at that chain's contracts

---

## Submission Status

- [x] CRE workflow implemented and simulated
- [x] Smart contracts deployed and verified on Base Sepolia
- [x] Full demo flow executed on-chain (deposit → mint → liquidation)
- [x] Public code available
- [ ] Video explainer (≤5 minutes) — **Pending**

## Video

- Demo video link: `TBD (to add before final submission)`
