// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CDPCore} from "../src/CDPCore.sol";

/**
 * @notice Calls CDPCore.onReport directly (bypassing Keystone Forwarder) for demo/simulation.
 * Requires the caller to be an authorized forwarder on CDPCore.
 */
contract AttestDirectScript is Script {
    address constant CDP_CORE = 0x5f39FEF37F63712eC2346725876dD765fc57F503;

    function run() external {
        address workflowOwner = 0x8966caCc8E138ed0a03aF3Aa4AEe7B79118C420E;

        console.log("Calling onReport directly as forwarder:", workflowOwner);

        // Build metadata: workflowOwner (20 bytes) packed at start
        // CDPCore reads: shr(96, calldataload(metadata.offset)) = first 20 bytes
        bytes memory metadata = abi.encodePacked(
            workflowOwner,          // 20 bytes — extracted as workflowOwner
            bytes10(0),             // workflowName placeholder
            bytes32(0),             // workflowCID placeholder
            bytes32(0),             // workflowExecutionID placeholder
            bytes2(0)               // reportID placeholder
        );

        // V2 attestation: txid, amountSat, blockHeight, btcPriceUsd, timestamp, depositor, mintAmountUsd
        bytes32 txid = 0x19d0b8f9031e75129647e996b4d0fa04e719ed0404ead52ff6923ca0af5f1662;
        uint64  amountSat = 162253;
        uint32  blockHeight = 125302;
        uint256 btcPriceUsd = 6730345344555; // $67,303 with 8 decimals
        uint256 timestamp = block.timestamp;
        address depositor = workflowOwner;
        uint256 mintAmountUsd = 1_000_000 * 1e18; // request max, capped by MCR

        bytes memory report = abi.encode(txid, amountSat, blockHeight, btcPriceUsd, timestamp, depositor, mintAmountUsd);

        console.log("Report length (should be 224 = 7*32):", report.length);
        console.log("Timestamp:", timestamp);

        vm.startBroadcast();
        CDPCore(CDP_CORE).onReport(metadata, report);
        vm.stopBroadcast();

        // Read back vault state
        (uint256 collateralSat, uint256 debtUsd,,,bool active) = CDPCore(CDP_CORE).vaults(depositor);
        console.log("Vault active:", active);
        console.log("Collateral (sats):", collateralSat);
        console.log("Debt btcUSD (wei):", debtUsd);
        console.log("Debt btcUSD:", debtUsd / 1e18);
    }
}
