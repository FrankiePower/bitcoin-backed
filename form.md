Convergence | A Chainlink Hackathon

Project name
Bitcoin-Backed (btcUSD)

1 line project description (under ~80-100 characters)
Bitcoin-backed stablecoin using Chainlink CRE attestations and on-chain CDP minting.

Full project description
btcUSD is a Bitcoin-collateralized stablecoin protocol. Users deposit BTC to a monitored Bitcoin Testnet4 vault address, and a Chainlink CRE workflow fetches confirmed UTXOs from mempool.space, reaches DON consensus, reads BTC/USD from Chainlink Data Feeds, and submits signed reports to CDPCore on Base Sepolia.

CDPCore records collateral, enforces collateralization constraints, and allows btcUSD minting against attested BTC collateral. The protocol targets a core DeFi problem: most BTC-backed stablecoin systems rely on custodial or trusted relayer assumptions. This project demonstrates a CRE-based on-chain attestation path for BTC collateral state and transparent CDP accounting.

How is it built?
- Smart contracts: Solidity + Foundry
  - `contracts/src/CDPCore.sol` (attestation receiver + CDP logic)
  - `contracts/src/btcUSD.sol` (mint/burn token, CCIP-ready interfaces)
- Workflow: TypeScript + Chainlink CRE SDK
  - `btcusd-workflow/main.ts`
  - HTTP capability for Bitcoin UTXO data (mempool.space)
  - EVM capability for reads/writes and report submission
- Oracle data:
  - Chainlink BTC/USD Data Feed on Base Sepolia
- Config and simulation:
  - `project.yaml` and `btcusd-workflow/config.json`
  - CRE CLI simulation path validated

What challenges did you run into?
- Aligning health-factor units between workflow checks and on-chain CDP math
- Reliable RPC configuration for CRE simulation and finalized-block reads
- Designing backward-compatible report encoding while extending workflow behavior
- Clarifying live vs simulated CCIP bridging scope under hackathon time constraints

Link to project repo
https://github.com/FrankiePower/bitcoin-backed

Chainlink Usage
Core workflow:
https://github.com/FrankiePower/bitcoin-backed/blob/main/btcusd-workflow/main.ts

Contracts integrated with Chainlink flow:
https://github.com/FrankiePower/bitcoin-backed/blob/main/contracts/src/CDPCore.sol
https://github.com/FrankiePower/bitcoin-backed/blob/main/contracts/src/btcUSD.sol

README with all Chainlink-linked files:
https://github.com/FrankiePower/bitcoin-backed/blob/main/README.md

Project Demo
Add your 3-5 minute public demo link here before final submission:
[PASTE_VIDEO_LINK_HERE]

Which Chainlink prize track(s) are you applying to?
DeFi and Tokenization

Which sponsor track(s) are you applying to?
None

Submitter name
Franklin

Submitter email
franklin.power21@gmail.com

Are you participating in a team or individually?
Individual
