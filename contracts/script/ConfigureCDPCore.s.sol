// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CDPCore} from "../src/CDPCore.sol";

contract ConfigureCDPCoreScript is Script {
    // Base Sepolia Keystone Forwarder addresses
    address constant SIMULATION_FORWARDER = 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5;
    address constant PRODUCTION_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    // Deployed CDPCore address on Base Sepolia
    address constant CDP_CORE = 0x5f39FEF37F63712eC2346725876dD765fc57F503;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("CRE_ETH_PRIVATE_KEY");
        address workflowOwner = vm.addr(deployerPrivateKey);

        console.log("Configuring CDPCore at:", CDP_CORE);
        console.log("Workflow owner:", workflowOwner);

        vm.startBroadcast(deployerPrivateKey);

        CDPCore cdpCore = CDPCore(CDP_CORE);

        // 1. Set Keystone Forwarder (using simulation for staging)
        console.log("Setting Keystone Forwarder (simulation):", SIMULATION_FORWARDER);
        cdpCore.setKeystoneForwarder(SIMULATION_FORWARDER, true);

        // 2. Set Workflow Owner (the deployer address)
        console.log("Setting Workflow Owner:", workflowOwner);
        cdpCore.setWorkflowOwner(workflowOwner, true);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Configuration Complete ===");
        console.log("CDPCore:", CDP_CORE);
        console.log("Keystone Forwarder:", SIMULATION_FORWARDER);
        console.log("Workflow Owner:", workflowOwner);
        console.log("");
        console.log("CDPCore is now ready to receive CRE attestations!");
    }
}
