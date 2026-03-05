// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BtcUSD} from "../src/btcUSD.sol";
import {CDPCore} from "../src/CDPCore.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy BtcUSD
        BtcUSD btcUsd = new BtcUSD();
        console.log("BtcUSD deployed at:", address(btcUsd));

        // 2. Deploy CDPCore with btcUSD address
        CDPCore cdpCore = new CDPCore(address(btcUsd));
        console.log("CDPCore deployed at:", address(cdpCore));

        // 3. Set CDPCore on btcUSD (grants mint/burn roles)
        btcUsd.setCdpCore(address(cdpCore));
        console.log("CDPCore set on BtcUSD");

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("BtcUSD:", address(btcUsd));
        console.log("CDPCore:", address(cdpCore));
        console.log("");
        console.log("Next steps:");
        console.log("1. Set Keystone Forwarder on CDPCore");
        console.log("2. Set Workflow Owner on CDPCore");
        console.log("3. Update btcusd-workflow/config.json with these addresses");
    }
}
