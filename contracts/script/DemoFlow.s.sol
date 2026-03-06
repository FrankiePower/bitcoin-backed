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
    address constant CDP_CORE = 0x4F545CE997b7A5fEA9101053596D4834Bc882c7f;
    address constant BTC_USD = 0xA5FCD5d200f949F7e78D4c7771F602aa4B0e387A;

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

        // Mint btcUSD ($60 worth, safe under 150% MCR)
        uint256 mintAmount = 60 * 1e18;
        cdpCore.mintBtcUsd(mintAmount);
        console.log("Minted: 60 btcUSD");

        // Final state
        uint256 balance = btcUsd.balanceOf(user);
        uint256 hf = cdpCore.healthFactor(user);
        console.log("btcUSD balance:", balance / 1e18);
        console.log("Health factor:", hf);

        vm.stopBroadcast();
        console.log("=== Demo Complete ===");
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
