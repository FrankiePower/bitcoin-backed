// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CDPCore} from "../src/CDPCore.sol";

/**
 * @notice Submits a V3 snapshot (collateral=0) then a V4 liquidation report directly to CDPCore.
 * Use after sweeping the BTC vault to demonstrate autonomous liquidation.
 * Requires the caller to be an authorized forwarder on CDPCore.
 */
contract LiquidateDirectScript is Script {
    address constant CDP_CORE     = 0x5f39FEF37F63712eC2346725876dD765fc57F503;
    address constant DEPOSITOR    = 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E;
    address constant WORKFLOW_OWNER = 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E;

    bytes32 constant VAULT_SNAPSHOT_REPORT_KIND    = keccak256("BTCUSD_VAULT_SNAPSHOT_V1");
    bytes32 constant VAULT_LIQUIDATION_REPORT_KIND = keccak256("BTCUSD_LIQUIDATION_V1");

    function run() external {
        // Build metadata: workflowOwner packed at start (CDPCore reads first 20 bytes)
        bytes memory metadata = abi.encodePacked(
            WORKFLOW_OWNER,
            bytes10(0),
            bytes32(0),
            bytes32(0),
            bytes2(0)
        );

        vm.startBroadcast();

        CDPCore cdpCore = CDPCore(CDP_CORE);

        // --- Step 1: V3 Snapshot — set collateral to 0 (vault is empty) ---
        console.log("Step 1: Submitting V3 snapshot with collateral=0...");

        uint256 btcPrice = 6708705000000; // ~$67,087 (use latest price)
        bytes memory snapshotReport = abi.encode(
            VAULT_SNAPSHOT_REPORT_KIND,
            DEPOSITOR,
            uint256(0),         // collateralSat = 0 (vault swept)
            btcPrice,
            block.timestamp,
            uint256(0),         // mintAmountUsd = 0
            uint256(0),         // reserved
            uint256(1)          // version
        );
        cdpCore.onReport(metadata, snapshotReport);

        // Check health after snapshot
        uint256 hf = cdpCore.healthFactor(DEPOSITOR);
        console.log("Health factor after snapshot:", hf);

        // --- Step 2: V4 Liquidation — burn debt, clear vault ---
        console.log("Step 2: Submitting V4 liquidation report...");

        bytes memory liquidationReport = abi.encode(
            VAULT_LIQUIDATION_REPORT_KIND,
            DEPOSITOR,
            block.timestamp
        );
        cdpCore.onReport(metadata, liquidationReport);

        vm.stopBroadcast();

        // Final vault state
        (uint256 collateralSat, uint256 debtUsd,,, bool active) = cdpCore.vaults(DEPOSITOR);
        console.log("=== Final Vault State ===");
        console.log("Collateral (sats):", collateralSat);
        console.log("Debt btcUSD:", debtUsd / 1e18);
        console.log("Active:", active);
    }
}
