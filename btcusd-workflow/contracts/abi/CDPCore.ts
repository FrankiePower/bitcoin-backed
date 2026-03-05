// CDPCore ABI - only functions needed for workflow interactions
export const CDPCore = [
    {
        "inputs": [
            { "internalType": "bytes32", "name": "txid", "type": "bytes32" }
        ],
        "name": "isAttested",
        "outputs": [
            { "internalType": "bool", "name": "", "type": "bool" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "user", "type": "address" }
        ],
        "name": "getVault",
        "outputs": [
            { "internalType": "uint256", "name": "collateralSat", "type": "uint256" },
            { "internalType": "uint256", "name": "debtUsd", "type": "uint256" },
            { "internalType": "uint256", "name": "lastAttested", "type": "uint256" },
            { "internalType": "uint256", "name": "lastBtcPrice", "type": "uint256" },
            { "internalType": "bool", "name": "active", "type": "bool" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "user", "type": "address" }
        ],
        "name": "healthFactor",
        "outputs": [
            { "internalType": "uint256", "name": "", "type": "uint256" }
        ],
        "stateMutability": "view",
        "type": "function"
    }
] as const;
