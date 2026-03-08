# btcUSD Demo Commands

## Contracts (Base Sepolia)

| Contract | Address |
|---|---|
| CDPCore | `0x5f39FEF37F63712eC2346725876dD765fc57F503` |
| btcUSD | `0xd1A11b5896AA39fB7c7f594Eea48bf16aF0C2aF5` |
| Keystone Forwarder (simulation) | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |

## Bitcoin Testnet4 Wallets

| Wallet | Address |
|---|---|
| Vault (monitored by workflow) | `tb1qvwgjgrxvq3nztnz5tpwquxx30ps66vcx0jl7lh` |
| Destination (sweep target) | `tb1q330pfkf4nequ54d6csputtssq4w8n95r4276g4` |

Faucet: https://testnet4.anyone.eu.org

---

## Demo Flow

### 1. Deposit BTC to vault

```bash
# Send 25% of destination wallet balance to vault (default)
source .env && bun run scripts/send-btc.ts $BTC_DESTINATION_WIF $BTC_VAULT_ADDRESS

# Send specific amount (sats)
source .env && bun run scripts/send-btc.ts $BTC_DESTINATION_WIF $BTC_VAULT_ADDRESS 50000
```

Wait for 1 confirmation (~10 min testnet4).

### 2. Run workflow (attests deposit + auto-mints btcUSD)

```bash
# Simulation only (no on-chain writes)
source .env && cre workflow simulate ./btcusd-workflow --target staging-settings

# Broadcast (real on-chain transactions)
source .env && cre workflow simulate ./btcusd-workflow --target staging-settings --broadcast
```

### 3. Check balances

```bash
# btcUSD balance
cast call 0xd1A11b5896AA39fB7c7f594Eea48bf16aF0C2aF5 \
  "balanceOf(address)(uint256)" 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E \
  --rpc-url $TESTNET_RPC_URL

# CDP vault state (collateralSat, debtUsd, lastAttested, lastBtcPrice, active)
cast call 0x5f39FEF37F63712eC2346725876dD765fc57F503 \
  "vaults(address)(uint256,uint256,uint256,uint256,bool)" 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E \
  --rpc-url $TESTNET_RPC_URL

# Health factor (>=100 = safe, <100 = liquidatable, uint256.max = no debt)
cast call 0x5f39FEF37F63712eC2346725876dD765fc57F503 \
  "healthFactor(address)(uint256)" 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E \
  --rpc-url $TESTNET_RPC_URL
```

### 4. Trigger liquidation (sweep vault BTC)

```bash
# Sweep entire vault balance to destination
source .env && bun run scripts/send-btc.ts $BTC_VAULT_WIF $BTC_DESTINATION_ADDRESS --sweep
```

Wait for 1 confirmation. Then run workflow again — snapshot detects 0 collateral, health drops to 0, V4 liquidation report fires and burns the btcUSD debt.

```bash
source .env && cre workflow simulate ./btcusd-workflow --target staging-settings --broadcast
```

---

## Forge Scripts

All run from `contracts/` directory. Always `source ../.env` first.

```bash
cd contracts && source ../.env
```

### Deploy contracts

```bash
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $TESTNET_RPC_URL --private-key 0x$CRE_ETH_PRIVATE_KEY --broadcast
```

### Configure CDPCore (after deploy or redeployment)

```bash
forge script script/ConfigureCDPCore.s.sol:ConfigureCDPCoreScript \
  --rpc-url $TESTNET_RPC_URL --private-key 0x$CRE_ETH_PRIVATE_KEY --broadcast
```

Sets: simulation forwarder, deployer EOA as forwarder, workflow owner, simulation workflow owner (0xaaa...).

### Direct attestation (bypasses Keystone Forwarder)

```bash
forge script script/AttestDirect.s.sol:AttestDirectScript \
  --rpc-url $TESTNET_RPC_URL --private-key 0x$CRE_ETH_PRIVATE_KEY --broadcast
```

### Direct liquidation (snapshot collateral=0 + burn debt)

Run after sweeping the vault BTC.

```bash
forge script script/LiquidateDirect.s.sol:LiquidateDirectScript \
  --rpc-url $TESTNET_RPC_URL --private-key 0x$CRE_ETH_PRIVATE_KEY --broadcast
```

---

## Explorer Links

- Base Sepolia: https://sepolia.basescan.org
- Bitcoin Testnet4: https://mempool.space/testnet4
