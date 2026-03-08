// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BtcUSD} from "../src/btcUSD.sol";

/**
 * @title CCIPBridgeDemo
 * @notice Demonstrates CCIP burn-and-mint readiness for btcUSD.
 * @dev This is a simulation script. Full cross-chain minting requires:
 *      - BurnMintTokenPool on both chains
 *      - TokenAdminRegistry pool registration
 *      - Route configuration between pools
 */
contract CCIPBridgeDemo is Script {
    // Base Sepolia deployed contracts
    address constant BTC_USD = 0x5a458544342eEaA64BB6b9940F826cbd74d62D8E;

    // Chain selectors
    uint64 constant BASE_SEPOLIA_SELECTOR = 10344971235874465080;
    uint64 constant ETHEREUM_SEPOLIA_SELECTOR = 16015286601757825753;

    function run() external {
        uint256 pk = vm.envUint("CRE_ETH_PRIVATE_KEY");
        address user = vm.addr(pk);

        console.log("=== CCIP Bridge Demo (Simulated) ===");
        console.log("User:", user);

        BtcUSD btcUsd = BtcUSD(BTC_USD);

        vm.startBroadcast(pk);

        uint256 startBalance = btcUsd.balanceOf(user);
        console.log("Starting btcUSD balance:", startBalance / 1e18);

        if (startBalance == 0) {
            console.log("ERROR: No btcUSD balance to bridge.");
            console.log("Run DemoFlow.s.sol first.");
            vm.stopBroadcast();
            return;
        }

        uint256 bridgeAmount = 10 * 1e18;
        if (startBalance < bridgeAmount) {
            bridgeAmount = startBalance / 2;
        }

        console.log("--- Step 1: Simulate source burn on Base Sepolia ---");
        console.log("Amount:", bridgeAmount / 1e18, "btcUSD");
        console.log("Source selector:", BASE_SEPOLIA_SELECTOR);
        console.log("Destination selector:", ETHEREUM_SEPOLIA_SELECTOR);

        // In production this burn is called by CCIP TokenPool. For demo we burn directly.
        btcUsd.burn(bridgeAmount);
        uint256 afterBurnBalance = btcUsd.balanceOf(user);

        console.log("Burned:", bridgeAmount / 1e18, "btcUSD");
        console.log("Balance after burn:", afterBurnBalance / 1e18, "btcUSD");

        console.log("--- Step 2: Simulate destination mint on Ethereum Sepolia ---");
        console.log("In production, destination TokenPool mints the same amount to recipient.");

        console.log("=== Demo Complete ===");
        console.log("btcUSD is CCIP-ready via IBurnMintERC20-compatible mint/burn interfaces.");

        vm.stopBroadcast();
    }
}
