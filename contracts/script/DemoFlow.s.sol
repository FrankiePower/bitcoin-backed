// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CDPCore} from "../src/CDPCore.sol";
import {BtcUSD} from "../src/btcUSD.sol";

/**
 * @title DemoFlow
 * @notice Demonstrates the full btcUSD flow by simulating CRE attestations
 */
contract DemoFlowScript is Script {
    address constant CDP_CORE = 0x25cb5d05f22f218818Bd950969fCd6Ba0E196FaC;
    address constant BTC_USD = 0x5a458544342eEaA64BB6b9940F826cbd74d62D8E;

    function run() external {
        uint256 pk = vm.envUint("CRE_ETH_PRIVATE_KEY");
        address user = vm.addr(pk);

        console.log("=== btcUSD Demo Flow ===");
        console.log("User:", user);

        CDPCore cdpCore = CDPCore(CDP_CORE);
        BtcUSD btcUsd = BtcUSD(BTC_USD);

        vm.startBroadcast(pk);

        // Allow user to submit attestations (simulating Keystone Forwarder)
        cdpCore.setKeystoneForwarder(user, true);
        cdpCore.setWorkflowOwner(user, true);

        // Attestation 1: UTXO b9ffa12b... (50,000 sats)
        _submitAttestation(
            cdpCore,
            user,
            bytes32(hex"a151a8be4c687caa0a3c6ca0bb0c0c22a103f3e04b7f4ca2582ed3692ba1ffb9"),
            50000,
            105926
        );
        console.log("Attested UTXO 1: 50,000 sats");

        // Attestation 2: UTXO 77b36f5d... (50,000 sats)
        _submitAttestation(
            cdpCore,
            user,
            bytes32(hex"3dde36e6197a1dad123f3e89a57bccc38bbe5e9931a613c44ffb529d5d6fb377"),
            50000,
            123623
        );
        console.log("Attested UTXO 2: 50,000 sats");

        // Check vault
        (uint256 collateral,,,,) = cdpCore.getVault(user);
        console.log("Total collateral:", collateral, "sats");

        // Mint btcUSD to max capacity (at 150% MCR, max = collateral_usd / 1.5)
        uint256 mintAmount = 60 * 1e18;
        cdpCore.mintBtcUsd(mintAmount);
        console.log("Minted: 60 btcUSD");

        uint256 balanceBefore = btcUsd.balanceOf(user);
        uint256 hfBefore = cdpCore.healthFactor(user);
        console.log("btcUSD balance:", balanceBefore / 1e18);
        console.log("Health factor (before liquidation):", hfBefore);

        // === Simulate Vault Withdrawal: snapshot with 0 collateral ===
        // This mimics the workflow detecting all BTC was spent out of the vault
        console.log("");
        console.log("=== Simulating Vault Withdrawal (Snapshot with 0 collateral) ===");
        _submitSnapshot(cdpCore, user, 0);
        console.log("Snapshot submitted: collateral = 0 sats");

        // Check health factor — should now be < 100 (liquidatable)
        uint256 hfAfter = cdpCore.healthFactor(user);
        bool liquidatable = hfAfter < 100 && hfAfter > 0;
        console.log("Health factor (after withdrawal):", hfAfter);
        console.log("Liquidatable:", liquidatable);

        vm.stopBroadcast();
        console.log("");
        console.log("=== Demo Complete ===");
    }

    function _submitSnapshot(CDPCore cdpCore, address user, uint256 collateralSat) internal {
        bytes32 reportKind = keccak256("BTCUSD_VAULT_SNAPSHOT_V1");
        uint256 btcPrice = 9500000000000; // $95,000
        bytes memory metadata = abi.encodePacked(user, bytes10(0));
        bytes memory report = abi.encode(reportKind, user, collateralSat, btcPrice, block.timestamp, uint256(0), uint256(0), uint256(1));
        cdpCore.onReport(metadata, report);
    }

    function _submitAttestation(
        CDPCore cdpCore,
        address user,
        bytes32 txid,
        uint64 amount,
        uint32 blockHeight
    ) internal {
        uint256 btcPrice = 9500000000000; // $95,000
        bytes memory metadata = abi.encodePacked(user, bytes10(0));
        bytes memory report = abi.encode(txid, amount, blockHeight, btcPrice, block.timestamp, user);
        cdpCore.onReport(metadata, report);
    }
}
