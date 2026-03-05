# btcUSD — Bitcoin-Backed Multichain Stablecoin

## What Is This

A CDP (Collateralized Debt Position) protocol where users lock real Bitcoin on the Bitcoin blockchain and mint a stablecoin (`btcUSD`) on EVM chains. No wrapped BTC. No custodian. No trusted bridge operator.

Chainlink CRE is the trustless relay between Bitcoin and EVM. CCIP makes btcUSD available across multiple chains from a single BTC deposit.

---

## The Problem It Solves

Every BTC-backed stablecoin today requires trusting someone:

| Protocol | Trust Assumption |
|---|---|
| WBTC | BitGo custodian holds your BTC |
| tBTC | Threshold Network multisig |
| renBTC | RenVM (now defunct — proved the risk) |
| Badger vaults | Wrapped BTC → same custodian risk |

If the custodian gets hacked, goes insolvent, or is sanctioned — your collateral is gone.

**The gap:** There is no CDP protocol where BTC collateral is verified directly from the Bitcoin blockchain by a decentralized oracle network.

---

## The Solution

```
User locks BTC → Bitcoin address (vault)
       ↓
CRE Workflow polls Bitcoin (Blockstream API)
Detects deposit confirmation (6 blocks)
Writes signed vault attestation → Base
       ↓
CDPCore (Base) reads CRE report
Mints btcUSD against attested collateral
       ↓
CCIP broadcasts vault state + btcUSD
to Arbitrum, Optimism, Ethereum
       ↓
User spends btcUSD on any chain
```

CRE is irreplaceable here — it's the only way to get Bitcoin state onto EVM without a centralized relayer. Remove CRE and you need a trusted operator. This is the same architectural role CRE played in BMCP (which won ETHGlobal Buenos Aires).

---

## Does This Make Sense to Build?

### Yes, because:

**1. The market exists and is large**
~$60B in WBTC/tBTC sits in DeFi right now. All of it carries custodian risk. There is genuine demand for trustless BTC collateral.

**2. The Chainlink integration is load-bearing**
CRE is not a nice-to-have — it IS the bridge. Without it, there is no protocol. Judges rewarded exactly this pattern in BMCP.

**3. Two Chainlink services, both essential**
- CRE: Bitcoin → EVM attestation (no CRE = no bridge)
- CCIP: EVM → multichain distribution (no CCIP = single-chain only)

**4. Fits the DeFi & Tokenization track perfectly**
Judges listed "stablecoin issuance" as the first example use case. This is textbook.

**5. No one else is building this at this hackathon**
Bitcoin + CRE is a rare combo. Every other team is building on top of ETH/EVM-native assets.

### Honest Limitations:

**OP_CAT dropped for this project**
Full covenant enforcement (OP_CAT) requires a patched Bitcoin node and isn't on mainnet. For hackathon purposes the BTC vault is a watched P2WPKH address. The trust assumption moves from "custodian" to "user doesn't double-spend before 6 confirmations" — acceptable for a hackathon demo, needs OP_CAT for production.

**CRE attestation ≠ cryptographic proof of BTC lock**
CRE verifies the deposit happened but can't prevent the user from later spending the BTC (unless OP_CAT covenants are used). This is the same limitation as every existing BTC bridge — we're just replacing the centralized relayer with a decentralized oracle network.

**5 days to build**
Scope must be tight. The CRE workflow + one CDPCore contract + CCIP propagation is achievable. A polished frontend is a stretch goal.

---

## Architecture

### Components

| Layer | Component | Tech |
|---|---|---|
| Bitcoin | Vault address (P2WPKH) | Bitcoin |
| Oracle | CRE Workflow | CRE SDK (TypeScript) |
| Primary chain | CDPCore + btcUSD ERC20 | Solidity, Base Sepolia |
| Multichain | CCIP vault state sync | Solidity, Chainlink CCIP |
| Data source | Bitcoin block data | Blockstream API (free, no key) |

### CRE Workflow Logic

```
trigger: cron (every 2 minutes)

1. fetch confirmed deposits to vault address (Blockstream API)
2. filter: confirmations >= 6
3. for each new deposit:
   - encode: { depositor, amount_sat, txid, block_height }
   - write to CDPCore on Base via EVM write capability
```

### CDPCore Contract

```
functions:
- registerVault(address user, bytes vaultAddress)
- onCREReport(VaultAttestation report) — called by CRE Keystone Forwarder
- mintBTCUSD(uint256 amount) — mint against attested collateral
- repay(uint256 amount) — burn btcUSD, reduce debt
- liquidate(address user) — if health factor < 100

state:
- mcr: 150 (fixed for hackathon, upgradeable to dynamic)
- btcPrice: from Chainlink Price Feed (BTC/USD)
- vaults: mapping(address => VaultState)
```

### CCIP Propagation

When a vault is attested on Base:
- CCIP message sent to Arbitrum Sepolia + Optimism Sepolia
- Destination contracts update vault state
- btcUSD can be minted on any supported chain

---

## Hackathon Submission Checklist

- [ ] CRE workflow: Bitcoin deposit detection + on-chain write
- [ ] CDPCore.sol: accept CRE report, mint btcUSD
- [ ] btcUSD ERC20: mintable/burnable by CDPCore only
- [ ] CCIP sync: propagate vault state to 2 chains
- [ ] CRE CLI simulation passing
- [ ] 3–5 min demo video
- [ ] Public GitHub repo + README

## Stretch Goals (if time)

- [ ] Dynamic MCR via CRE volatility feed
- [ ] Frontend: deposit BTC address QR + mint UI
- [ ] Liquidation bot

---

## Track

**Primary:** DeFi & Tokenization ($20K / $12K / $8K)
**Potential secondary:** Risk & Compliance (if dynamic MCR is added)

---

## Why We're Doing This, Not Something Else

The Stablecoin Risk Guardian idea (monitoring existing stablecoins) is derivative — it consumes existing Chainlink feeds without creating a new financial primitive. btcUSD creates something that doesn't exist: a stablecoin backed by native BTC with a decentralized oracle bridge. The prior winners (BMCP) proved that Bitcoin + CRE is exactly the kind of novel architecture judges reward.
