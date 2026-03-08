# btcUSD — Bitcoin-Backed Stablecoin with Chainlink CRE

**Trustless Bitcoin-Collateralized Stablecoin using Chainlink's Decentralized Oracle Network**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-orange.svg)](https://soliditylang.org/)

## Overview

btcUSD enables users to deposit Bitcoin on the Bitcoin network and mint USD-pegged stablecoins on any EVM chain. The system uses **Chainlink CRE** (Chainlink Runtime Environment) for trustless Bitcoin deposit verification and **Chainlink Price Feeds** for real-time BTC/USD pricing. Multi-chain support is built in — deploy on any chain and update `config.json`.

## Submission Summary

### Problem

BTC-backed stablecoins typically require centralized custody or trusted bridge operators, introducing custodial and counterparty risk.

### Solution

btcUSD uses Chainlink CRE to attest confirmed Bitcoin UTXOs and update on-chain collateral state in `CDPCore`, enabling overcollateralized stablecoin minting on Base Sepolia.

### How CRE Is Used

- Fetch Bitcoin UTXOs (HTTP capability)
- Read BTC/USD and vault state (EVM read capability)
- Generate DON-signed attestation reports (`runtime.report`)
- Submit reports on-chain through Keystone Forwarder (EVM write/report capability)

### Submission Artifacts

- Submission draft: [`submission.md`](submission.md)
- Public repo: `https://github.com/FrankiePower/bitcoin-backed`
- Demo video: `TBD (to be added before final submission)`

### Key Features

- **Bitcoin Collateral**: Deposit BTC on Bitcoin Testnet4 to mint stablecoins on EVM
- **Chainlink CRE Attestation**: DON consensus verifies Bitcoin UTXOs exist
- **Real-time Pricing**: Chainlink BTC/USD Price Feed for accurate collateral valuation
- **CDP Mechanics**: 150% minimum collateral ratio with liquidation support
- **Liquidation Detection**: Workflow monitors vault health and flags undercollateralized positions
- **Multi-Chain**: Deploy on any EVM chain by updating `config.json` — no code changes needed
- **Fully On-Chain**: All CDP state managed transparently on Base Sepolia

## Architecture

```mermaid
flowchart TD
    User(["👤 User / Depositor"])

    subgraph BTC["⛓️ Bitcoin Testnet4"]
        Vault["🔐 Vault Address\ntb1qvwgj...7lh"]
    end

    subgraph Ext["🌐 External Data"]
        Mempool["mempool.space API\nUTXO data"]
        PriceFeed["🔮 Chainlink Price Feed\nBTC/USD · 8 decimals"]
    end

    subgraph CRE["⚡ Chainlink CRE — Decentralized Oracle Network"]
        direction TB
        Workflow["CRE Workflow\n every 30s cron"]
        Consensus["DON Consensus\nmedian block height\nidentical UTXO data"]
        Reports["DON-Signed Reports\nV2 Attestation · V3 Snapshot · V4 Liquidation"]
    end

    subgraph EVM["🔷 Base Sepolia"]
        KF["Keystone Forwarder\nonReport()"]
        CDP["CDPCore\n150% MCR · health factor"]
        Token["btcUSD Token\nERC20 · mint · burn"]
    end

    User -- "1. deposit BTC" --> Vault
    Vault -- "confirmed UTXO" --> Mempool
    Mempool -- "UTXO list" --> Workflow
    PriceFeed -- "BTC/USD price" --> Workflow
    Workflow --> Consensus --> Reports
    Reports -- "V2: attest + auto-mint" --> KF
    Reports -- "V3: collateral sync" --> KF
    Reports -- "V4: autonomous liquidation" --> KF
    KF --> CDP
    CDP -- "mint()" --> Token
    Token -- "2. receive btcUSD" --> User
```

## Complete Message Flow

### Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant BTC as Bitcoin Testnet4
    participant MP as mempool.space
    participant CRE as CRE Workflow (DON)
    participant PF as Chainlink Price Feed
    participant KF as Keystone Forwarder
    participant CDP as CDPCore
    participant Token as btcUSD Token

    Note over User,Token: Phase 1 — Bitcoin Deposit
    User->>BTC: Send BTC to vault address
    BTC->>BTC: Wait 1 confirmation (~10 min)

    Note over User,Token: Phase 2 — CRE Attestation (every 30s cron)
    CRE->>MP: GET /address/{vault}/utxo
    MP-->>CRE: confirmed UTXOs
    CRE->>CRE: DON median consensus on block height
    CRE->>CRE: DON identical consensus on UTXO set
    CRE->>PF: latestRoundData() + staleness check
    PF-->>CRE: BTC/USD price (8 decimals)
    CRE->>CDP: isAttested(txid)?
    CDP-->>CRE: false — new UTXO

    CRE->>CRE: Encode V2 report (txid, sats, price, depositor, mintAmount)
    CRE->>KF: writeReport() — DON-signed
    KF->>CDP: onReport(metadata, report)
    CDP->>CDP: Validate signature · decode V2 · update collateral
    CDP->>Token: mint(depositor, autoMintAmount)
    Token-->>User: btcUSD received automatically

    Note over User,Token: Phase 3 — Collateral Sync (same cycle)
    CRE->>CRE: Encode V3 Snapshot (totalCollateralSat, price)
    CRE->>KF: writeReport() — V3
    KF->>CDP: onReport() · update collateral to exact UTXO sum

    Note over User,Token: Phase 4 — Health Check + Autonomous Liquidation
    CRE->>CDP: healthFactor(depositor)
    CDP-->>CRE: health factor (basis points)

    alt health < 100 (undercollateralized)
        CRE->>CRE: Encode V4 Liquidation (depositor, timestamp)
        CRE->>KF: writeReport() — V4
        KF->>CDP: onReport() · _applyLiquidation()
        CDP->>Token: burnFrom(depositor, debt)
        CDP->>CDP: clear vault
        Note right of CDP: No external liquidator needed
    else health ≥ 100
        CRE->>CRE: log ✓ vault healthy
    end
```

### Phase-by-Phase Breakdown

#### Phase 1: Bitcoin Deposit (~10 minutes)
- User sends BTC to the monitored vault address on Bitcoin Testnet4
- Transaction is broadcast and included in a block
- Wait for 1 confirmation (~10 minutes average on Testnet4)

#### Phase 2: CRE Attestation (~30 seconds)
- Workflow triggers on cron schedule (every 30 seconds)
- Fetches all UTXOs for vault address from mempool.space
- Filters for 1+ confirmation
- Checks CDPCore to skip already-attested UTXOs
- Reads BTC/USD price from Chainlink Price Feed with staleness check
- DON reaches consensus — median on block height, identical on UTXO set
- Submits V2 signed report to CDPCore via Keystone Forwarder
- CDPCore auto-mints btcUSD up to 66.67% of collateral value (no separate mint call needed)

#### Phase 3: Collateral Sync (~30 seconds)
- Same cron cycle submits V3 Snapshot with authoritative total collateral
- Detects spent UTXOs and reduces on-chain collateral accordingly
- Keeps vault state accurate even after partial withdrawals

#### Phase 4: Autonomous Liquidation (~30 seconds)
- Workflow reads health factor from CDPCore
- If health < 100 (undercollateralized), submits V4 Liquidation report
- CDPCore burns depositor's btcUSD debt directly and clears the vault
- No external liquidator wallet or token approval required

**Total Time**: ~10-15 minutes (Bitcoin confirmation dominates)

## Chainlink Integration

This project uses **two Chainlink services**:

| Service | Purpose | Implementation |
|---------|---------|----------------|
| **Chainlink CRE** | Bitcoin UTXO attestation workflow | [`btcusd-workflow/main.ts`](btcusd-workflow/main.ts) |
| **Chainlink Price Feeds** | Real-time BTC/USD oracle | [`main.ts:170-199`](btcusd-workflow/main.ts#L170-L199) |

### Files Using Chainlink

| File | Chainlink Usage |
|------|-----------------|
| [`btcusd-workflow/main.ts`](btcusd-workflow/main.ts) | CRE workflow, HTTPClient, EVMClient, consensusIdenticalAggregation, Price Feed read, liquidation monitoring |
| [`btcusd-workflow/contracts/abi/PriceFeedAggregator.ts`](btcusd-workflow/contracts/abi/PriceFeedAggregator.ts) | Chainlink Price Feed ABI (latestAnswer) |
| [`contracts/src/btcUSD.sol`](contracts/src/btcUSD.sol) | ERC20 token with mint/burn role system for CDPCore |
| [`contracts/src/CDPCore.sol`](contracts/src/CDPCore.sol) | Receives CRE attestations via Keystone Forwarder |
| [`contracts/script/ConfigureCDPCore.s.sol`](contracts/script/ConfigureCDPCore.s.sol) | Configures Keystone Forwarder and workflow owner addresses |

### CRE Workflow Capabilities Used

```typescript
// HTTP Client - fetches Bitcoin UTXOs from mempool.space
const httpClient = new cre.capabilities.HTTPClient()
httpClient.sendRequest(runtime, fetchUTXOsForConsensus, consensusIdenticalAggregation<string>())

// EVM Client - reads price feed and contract state
const evmClient = new cre.capabilities.EVMClient(chainSelector)
evmClient.callContract(runtime, { call: encodeCallMsg(...) })

// Report Generation - DON-signed attestations
runtime.report({ encodedPayload, encoderName: 'evm', signingAlgo: 'ecdsa' })

// Report Submission - via Keystone Forwarder
evmClient.writeReport(runtime, { receiver: cdpCoreAddress, report })
```

## Protocol Encoding

### VaultAttestation Structure

The CRE workflow encodes attestations using this ABI structure:

```solidity
struct VaultAttestation {
    bytes32 txid;        // Bitcoin transaction ID (reversed byte order)
    uint64 amountSat;    // Amount in satoshis
    uint32 blockHeight;  // Bitcoin block height
    uint256 btcPriceUsd; // BTC/USD price (8 decimals)
    uint256 timestamp;   // Unix timestamp
    address depositor;   // EVM address of depositor
}
```

### Example Encoded Report

```
0x                                                              // Report data
a151a8be4c687caa0a3c6ca0bb0c0c22a103f3e04b7f4ca2582ed3692ba1ffb9  // txid (bytes32)
000000000000c350                                                // amountSat (50,000 sats)
00019dd6                                                        // blockHeight (105,942)
0000000000000000000000000000000000000000000000000008a8e4b80e40    // btcPriceUsd ($95,000)
0000000000000000000000000000000000000000000000000000000065f5c8a0  // timestamp
0000000000000000000000008966cacc8e138ed0a03af3aa4aee7b79118c420e  // depositor
```

### CDP Mechanics

| Parameter | Value | Description |
|-----------|-------|-------------|
| **MCR** | 150% | Minimum Collateral Ratio |
| **Liquidation Threshold** | 100 | Health factor below which vault is liquidatable |
| **Price Staleness** | 15 minutes | Maximum age of price data |
| **Confirmations** | 1 | Required Bitcoin confirmations |
| **Cron Schedule** | Every 30s | Workflow execution frequency |

### Health Factor Calculation

```
Health Factor = (Collateral Value in USD) / (Debt * MCR)

Example:
- Collateral: 100,000 sats = 0.001 BTC
- BTC Price: $95,000
- Collateral Value: $95
- Debt: 50 btcUSD
- MCR: 150% = 1.5

Health Factor = $95 / ($50 * 1.5) = $95 / $75 = 126.67

If Health Factor < 100 → Position is liquidatable
```

## Deployed Contracts (Base Sepolia)

| Contract | Address | Explorer |
|----------|---------|----------|
| **BtcUSD** | `0x5a458544342eEaA64BB6b9940F826cbd74d62D8E` | [View](https://sepolia.basescan.org/address/0x5a458544342eEaA64BB6b9940F826cbd74d62D8E) |
| **CDPCore** | `0x5f39FEF37F63712eC2346725876dD765fc57F503` | [View](https://sepolia.basescan.org/address/0x5f39FEF37F63712eC2346725876dD765fc57F503) |

### Configuration

| Setting | Value |
|---------|-------|
| **Vault Address** | `tb1qvwgjgrxvq3nztnz5tpwquxx30ps66vcx0jl7lh` |
| **Keystone Forwarder** | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |
| **Workflow Owner** | `0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E` |
| **BTC/USD Feed** | Chainlink Base Sepolia |
| **Chain Selector** | `10344971235874465080` (Base Sepolia) |

## Quick Start

### Prerequisites

- [CRE CLI](https://docs.chain.link/cre) - Chainlink Runtime Environment CLI
- [Foundry](https://book.getfoundry.sh/) - Solidity development toolkit
- [Bun](https://bun.sh/) - JavaScript runtime

### Installation

```bash
# Clone the repository
git clone https://github.com/FrankiePower/bitcoin-backed.git
cd bitcoin-backed

# Install workflow dependencies
bun install --cwd ./btcusd-workflow

# Install contract dependencies
cd contracts && forge install && cd ..
```

### Configuration

Create a `.env` file in the contracts directory:

```env
# Your private key (with funds on Base Sepolia)
CRE_ETH_PRIVATE_KEY=0x<your-private-key>

# RPC URLs
BASE_SEPOLIA_RPC=https://base-sepolia-rpc.publicnode.com
```

### Run Simulation

```bash
# Simulate the CRE workflow
cre workflow simulate ./btcusd-workflow --target staging-settings
```

Expected output:
```
Initializing...
Compiling workflow...
✓ Workflow compiled
[USER LOG] === btcUSD Bitcoin Attestation Workflow ===
[USER LOG] Vault address: tb1qvwgjgrxvq3nztnz5tpwquxx30ps66vcx0jl7lh
[USER LOG] Found 2 confirmed UTXOs with 6+ confirmations
[USER LOG] BTC/USD price from Chainlink: 9500000000000 (8 decimals)
[USER LOG] === Checking Vault Health ===
[USER LOG] Health Factor: 12666666666666666666
[USER LOG] ✓ Vault is healthy (above 150% MCR)
```

### Run Demo (End-to-End)

```bash
cd contracts

# Set environment
export CRE_ETH_PRIVATE_KEY="0x<your-private-key>"

# Run demo flow (simulates attestation + mints btcUSD)
forge script script/DemoFlow.s.sol:DemoFlowScript \
  --rpc-url https://base-sepolia-rpc.publicnode.com \
  --broadcast
```

Expected output:
```
=== btcUSD Demo Flow ===
User: 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E
Attested UTXO 1: 50,000 sats
Attested UTXO 2: 50,000 sats
Total collateral: 100000 sats
Minted: 60 btcUSD
btcUSD balance: 60
Health factor: 158333333333333333333
=== Demo Complete ===
```

## Smart Contracts

### btcUSD Token

ERC20 stablecoin with role-based mint/burn access:

```solidity
contract BtcUSD is ERC20, ERC20Burnable, Ownable, IERC165 {
    // Minter/Burner roles for CDPCore (and future cross-chain pools)
    mapping(address => bool) private _minters;
    mapping(address => bool) private _burners;

    function mint(address account, uint256 amount) external onlyMinter;
    function burnFrom(address account, uint256 amount) public override onlyBurner;
}
```

### CDPCore

CDP (Collateralized Debt Position) manager receiving CRE attestations:

```solidity
contract CDPCore {
    struct Vault {
        uint256 collateralSat;    // Total BTC collateral in satoshis
        uint256 debtBtcUsd;       // Total btcUSD debt
        uint256 lastPriceUsd;     // Last attested BTC price
        uint256 lastUpdate;       // Timestamp of last attestation
        bytes32[] attestedTxids;  // List of attested Bitcoin txids
    }

    // Receive CRE attestations via Keystone Forwarder
    function onReport(bytes calldata metadata, bytes calldata report) external;

    // Mint btcUSD against collateral
    function mintBtcUsd(uint256 amount) external;

    // Repay debt and withdraw collateral
    function repayAndWithdraw(uint256 repayAmount) external;

    // Liquidate undercollateralized positions
    function liquidate(address user) external;

    // View functions
    function healthFactor(address user) external view returns (uint256);
    function getVault(address user) external view returns (Vault memory);
}
```

## Security Model & Limitations

### Current Implementation (v1 - Hackathon Demo)

| Aspect | Status | Notes |
|--------|--------|-------|
| Bitcoin attestation | ✅ Working | CRE verifies UTXOs exist via mempool.space |
| Price oracle | ✅ Working | Chainlink BTC/USD feed (8 decimals) |
| CDP mechanics | ✅ Working | 150% MCR, mint/repay/liquidate |
| Liquidation detection | ✅ Working | Workflow monitors vault health factor |
| DON consensus | ✅ Working | consensusIdenticalAggregation on UTXOs |
| **BTC custody enforcement** | ⚠️ **Not implemented** | See below |

### Important Limitation

**This is a proof-of-concept.** The current design attests that BTC exists at a vault address but does NOT enforce custody:

```
Current Model (Trusted):
1. User deposits BTC to vault address
2. CRE attests the UTXO exists
3. User mints btcUSD
4. ⚠️ User could move BTC (no on-chain enforcement)

Production Model (Trustless):
1. User deposits BTC to P2WSH script with spending conditions
2. CRE attests the locked UTXO
3. User mints btcUSD
4. ✅ BTC can only be unlocked when debt is repaid (enforced by Bitcoin script)
```

### Production Roadmap (v2)

For trustless BTC custody, future versions would implement:

| Feature | Description | Complexity |
|---------|-------------|------------|
| **DLC-based locking** | BTC locked in 2-of-2 multisig with oracle-signed spending conditions | High |
| **UTXO monitoring** | CRE detects if collateral UTXOs are spent, triggers liquidation | Medium |
| **P2WSH scripts** | Bitcoin-native spending conditions tied to EVM debt state | High |
| **BitVM verification** | ZK-proof based custody verification | Very High |

## Performance & Costs

### Timing Breakdown

| Phase | Duration | Notes |
|-------|----------|-------|
| Bitcoin deposit | Variable | User action |
| Block confirmation | ~10 minutes | 1 confirmation |
| CRE workflow cycle | ~30 seconds | Cron interval |
| Attestation + auto-mint | ~15 seconds | Single EVM tx via Keystone |
| Collateral snapshot | ~15 seconds | EVM tx |
| Liquidation (if triggered) | ~15 seconds | EVM tx, no external bot needed |
| **Total (deposit to mint)** | **~10-15 minutes** | Bitcoin finality dominates |

### Gas Costs (Base Sepolia)

| Operation | Estimated Gas | Cost at 0.001 gwei |
|-----------|--------------|-------------------|
| `onReport()` | ~150,000 | ~0.00015 ETH |
| `mintBtcUsd()` | ~80,000 | ~0.00008 ETH |
| `repayAndWithdraw()` | ~100,000 | ~0.0001 ETH |
| `liquidate()` | ~120,000 | ~0.00012 ETH |

## Comparison with Other Bitcoin-Backed Stablecoins

| Feature | btcUSD | eBTC (Badger) | DLLR (Sovryn) | USDe (Ethena) |
|---------|--------|---------------|---------------|---------------|
| **Collateral** | Native BTC | stETH (not BTC) | BTC (RSK) | ETH derivatives |
| **Oracle** | Chainlink CRE | Chainlink | Custom | Multiple |
| **Chain** | Any EVM (via config) | Ethereum | RSK only | Ethereum |
| **Min Collateral** | 150% | 110% | 110% | Variable |
| **Custody** | Attestation (v1) | Smart contract | Federated | Custodial |
| **Cross-chain** | Config-based deploy | No | No | No |

## Project Structure

```
bitcoin-backed/
├── btcusd-workflow/              # CRE workflow
│   ├── main.ts                   # Bitcoin attestation + liquidation monitoring
│   ├── config.json               # Vault address, chain config
│   └── contracts/abi/            # CDPCore, PriceFeed ABIs
├── contracts/                    # Solidity contracts
│   ├── src/
│   │   ├── btcUSD.sol            # ERC20 + CCIP compatible token
│   │   └── CDPCore.sol           # CDP logic + CRE receiver
│   └── script/
│       ├── Deploy.s.sol          # Deployment script
│       ├── ConfigureCDPCore.s.sol # Keystone Forwarder setup
│       └── DemoFlow.s.sol        # End-to-end demo
├── project.yaml                  # CRE project config
└── README.md                     # This file
```

## Roadmap

- [x] Core CRE workflow implementation
- [x] Bitcoin UTXO attestation via mempool.space
- [x] Chainlink Price Feed integration
- [x] CDPCore contract with mint/repay/liquidate
- [x] Auto-mint via V2 report (single tx deposit + mint)
- [x] V3 Snapshot sync for collateral reduction
- [x] V4 autonomous liquidation (DON-signed, no external bot needed)
- [ ] Production deployment on mainnet
- [ ] Multi-depositor support (per-user vault addresses)
- [ ] P2WSH custody enforcement
- [ ] DLC integration for trustless locking
- [ ] Cross-chain token bridging

## Testing

```bash
# Run CRE workflow simulation
cre workflow simulate ./btcusd-workflow --target staging-settings

# Run Solidity tests
cd contracts
forge test

# Run with verbosity
forge test -vvv
```

## References

- [Chainlink CRE Documentation](https://docs.chain.link/cre)
- [Chainlink Price Feeds](https://docs.chain.link/data-feeds)
- [DLC Specifications](https://github.com/discreetlogcontracts/dlcspecs) - Future custody model
- [mempool.space API](https://mempool.space/docs/api) - Bitcoin UTXO data

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Chainlink** for CRE and Price Feeds infrastructure
- **mempool.space** for Bitcoin Testnet4 API
- **Base** for EVM execution environment
- **Foundry** for Solidity development toolkit

---

**Built for ChainLink Convergence Hackathon - DeFi & Tokenization Track**
