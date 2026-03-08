// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BtcUSD} from "./btcUSD.sol";

/**
 * @title CDPCore
 * @notice Core CDP contract for btcUSD. Accepts CRE attestations for Bitcoin deposits,
 *         tracks vault state, and gates minting based on collateral health.
 */
contract CDPCore is Ownable {
    // ============ Structs ============

    /// @notice Attestation data from CRE workflow
    struct VaultAttestation {
        bytes32 txid; // Bitcoin txid (32 bytes)
        uint64 amountSat; // BTC amount in satoshis
        uint32 blockHeight; // Bitcoin block height of confirmation
        uint256 btcPriceUsd; // BTC/USD price (8 decimals from Chainlink)
        uint256 timestamp; // Attestation timestamp
        address depositor; // EVM address that owns this vault
    }

    /// @notice Extended attestation format with optional requested auto-mint amount.
    struct VaultAttestationV2 {
        bytes32 txid; // Bitcoin txid (32 bytes)
        uint64 amountSat; // BTC amount in satoshis
        uint32 blockHeight; // Bitcoin block height of confirmation
        uint256 btcPriceUsd; // BTC/USD price (8 decimals from Chainlink)
        uint256 timestamp; // Attestation timestamp
        address depositor; // EVM address that owns this vault
        uint256 mintAmountUsd; // Optional requested mint amount (18 decimals)
    }

    /// @notice Liquidation report: DON signals that a vault is undercollateralized and should be liquidated.
    struct VaultLiquidationReportV4 {
        bytes32 reportKind; // Must match VAULT_LIQUIDATION_REPORT_KIND
        address depositor;  // Vault owner to liquidate
        uint256 timestamp;  // Report timestamp (for staleness check)
    }

    /// @notice Snapshot report format for vault collateral synchronization.
    struct VaultSnapshotReportV3 {
        bytes32 reportKind; // Must match VAULT_SNAPSHOT_REPORT_KIND
        address depositor;
        uint256 collateralSat; // Authoritative confirmed UTXO sum at vault address
        uint256 btcPriceUsd; // BTC/USD price (8 decimals)
        uint256 timestamp;
        uint256 mintAmountUsd; // Optional requested auto-mint amount
        uint256 reserved; // Reserved for future use, must be 0
        uint256 version; // Reserved for future use, currently 1
    }

    /// @notice User vault state
    struct Vault {
        uint256 collateralSat; // Total attested BTC in satoshis
        uint256 debtUsd; // Minted btcUSD (18 decimals)
        uint256 lastAttested; // Timestamp of last valid CRE report
        uint256 lastBtcPrice; // Last attested BTC price (8 decimals)
        bool active; // Whether vault is active
    }

    // ============ Constants ============

    /// @notice Minimum collateral ratio (150% = 15000 basis points)
    uint256 public constant MCR = 150;

    /// @notice Staleness limit for attestations (15 minutes)
    uint256 public constant STALENESS_LIMIT = 15 minutes;

    /// @notice BTC price decimals (Chainlink standard)
    uint256 public constant BTC_PRICE_DECIMALS = 8;

    /// @notice Satoshis per BTC
    uint256 public constant SATS_PER_BTC = 1e8;
    bytes32 public constant VAULT_SNAPSHOT_REPORT_KIND = keccak256("BTCUSD_VAULT_SNAPSHOT_V1");
    bytes32 public constant VAULT_LIQUIDATION_REPORT_KIND = keccak256("BTCUSD_LIQUIDATION_V1");

    // ============ State ============

    BtcUSD public btcUsd;

    /// @notice Keystone Forwarder addresses allowed to submit reports
    mapping(address => bool) public allowedKeystoneForwarders;

    /// @notice User vaults
    mapping(address => Vault) public vaults;

    /// @notice Track attested txids to prevent double-attestation
    mapping(bytes32 => bool) public attestedTxids;

    /// @notice Allowed workflow owners for CRE reports
    mapping(address => bool) public allowedWorkflowOwners;

    // ============ Events ============

    event VaultAttested(
        address indexed depositor, bytes32 indexed txid, uint64 amountSat, uint256 btcPriceUsd, uint32 blockHeight
    );

    event BtcUSDMinted(address indexed user, uint256 amount, uint256 newDebt);
    event BtcUSDRepaid(address indexed user, uint256 amount, uint256 remainingDebt);
    event VaultLiquidated(address indexed user, address indexed liquidator, uint256 debtCleared);
    event KeystoneForwarderSet(address indexed forwarder, bool allowed);
    event WorkflowOwnerSet(address indexed owner, bool allowed);
    event AutoMintOnAttestation(address indexed user, uint256 requestedAmountUsd, uint256 mintedAmountUsd, uint256 newDebt);
    event VaultSnapshotSynced(
        address indexed user, uint256 previousCollateralSat, uint256 newCollateralSat, uint256 btcPriceUsd, uint256 timestamp
    );

    // ============ Errors ============

    error OnlyKeystoneForwarder();
    error UnauthorizedWorkflowOwner(address workflowOwner);
    error TxidAlreadyAttested(bytes32 txid);
    error AttestationStale();
    error InsufficientCollateral();
    error HealthFactorTooLow();
    error NoDebtToRepay();
    error VaultHealthy();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidReportFormat();

    // ============ Modifiers ============

    modifier onlyKeystone() {
        _checkKeystone();
        _;
    }

    function _checkKeystone() internal view {
        if (!allowedKeystoneForwarders[msg.sender]) revert OnlyKeystoneForwarder();
    }

    // ============ Constructor ============

    constructor(address _btcUsd) Ownable(msg.sender) {
        if (_btcUsd == address(0)) revert ZeroAddress();
        btcUsd = BtcUSD(_btcUsd);
    }

    // ============ Admin Functions ============

    function setKeystoneForwarder(address _forwarder, bool _allowed) external onlyOwner {
        if (_forwarder == address(0)) revert ZeroAddress();
        allowedKeystoneForwarders[_forwarder] = _allowed;
        emit KeystoneForwarderSet(_forwarder, _allowed);
    }

    function setWorkflowOwner(address _owner, bool _allowed) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        allowedWorkflowOwners[_owner] = _allowed;
        emit WorkflowOwnerSet(_owner, _allowed);
    }

    // ============ CRE Report Handler ============

    /**
     * @notice Called by Keystone Forwarder with signed CRE report
     * @param metadata Report metadata (contains workflow owner, etc.)
     * @param report Encoded VaultAttestation
     */
    function onReport(bytes calldata metadata, bytes calldata report) external onlyKeystone {
        // Extract workflow owner from metadata (first 20 bytes after initial bytes)
        // Metadata format: workflowOwner (address) + workflowName (bytes10) + ...
        address workflowOwner;
        assembly {
            // Skip first 4 bytes (length prefix in calldata), then read 20 bytes
            workflowOwner := shr(96, calldataload(add(metadata.offset, 0)))
        }

        if (!allowedWorkflowOwners[workflowOwner]) {
            revert UnauthorizedWorkflowOwner(workflowOwner);
        }

        // Decode report versions:
        // - V1: (txid, amountSat, blockHeight, btcPriceUsd, timestamp, depositor)
        // - V2: V1 + mintAmountUsd
        // - V3 Snapshot: (reportKind, depositor, collateralSat, btcPriceUsd, timestamp, mintAmountUsd, reserved, version)
        VaultAttestation memory attestation;
        uint256 requestedMintAmountUsd = 0;
        if (report.length == 32 * 3) {
            // V4 Liquidation: (reportKind, depositor, timestamp)
            VaultLiquidationReportV4 memory liq = abi.decode(report, (VaultLiquidationReportV4));
            if (liq.reportKind != VAULT_LIQUIDATION_REPORT_KIND) revert InvalidReportFormat();
            if (block.timestamp - liq.timestamp > STALENESS_LIMIT) revert AttestationStale();
            _applyLiquidation(liq.depositor);
            return;
        } else if (report.length == 32 * 8) {
            VaultSnapshotReportV3 memory snapshot = abi.decode(report, (VaultSnapshotReportV3));
            if (snapshot.reportKind != VAULT_SNAPSHOT_REPORT_KIND) revert InvalidReportFormat();
            _applySnapshot(snapshot);
            return;
        } else if (report.length == 32 * 6) {
            attestation = abi.decode(report, (VaultAttestation));
        } else if (report.length == 32 * 7) {
            VaultAttestationV2 memory attestationV2 = abi.decode(report, (VaultAttestationV2));
            attestation = VaultAttestation({
                txid: attestationV2.txid,
                amountSat: attestationV2.amountSat,
                blockHeight: attestationV2.blockHeight,
                btcPriceUsd: attestationV2.btcPriceUsd,
                timestamp: attestationV2.timestamp,
                depositor: attestationV2.depositor
            });
            requestedMintAmountUsd = attestationV2.mintAmountUsd;
        } else {
            revert InvalidReportFormat();
        }

        // Check for double-attestation
        if (attestedTxids[attestation.txid]) {
            revert TxidAlreadyAttested(attestation.txid);
        }

        // Mark txid as attested
        attestedTxids[attestation.txid] = true;

        // Update vault state
        Vault storage vault = vaults[attestation.depositor];
        vault.collateralSat += attestation.amountSat;
        vault.lastAttested = attestation.timestamp;
        vault.lastBtcPrice = attestation.btcPriceUsd;
        vault.active = true;

        // Optional auto-mint path driven by workflow report.
        // Requested amount is safely capped by available debt capacity.
        if (requestedMintAmountUsd > 0) {
            uint256 mintedAmount = _mintUpToCapacity(attestation.depositor, requestedMintAmountUsd);
            emit AutoMintOnAttestation(attestation.depositor, requestedMintAmountUsd, mintedAmount, vault.debtUsd);
        }

        emit VaultAttested(
            attestation.depositor,
            attestation.txid,
            attestation.amountSat,
            attestation.btcPriceUsd,
            attestation.blockHeight
        );
    }

    // ============ User Functions ============

    /**
     * @notice Mint btcUSD against attested collateral
     * @param amountUsd Amount of btcUSD to mint (18 decimals)
     */
    function mintBtcUsd(uint256 amountUsd) external {
        if (amountUsd == 0) revert ZeroAmount();

        Vault storage vault = vaults[msg.sender];

        // Check staleness
        if (block.timestamp - vault.lastAttested > STALENESS_LIMIT) {
            revert AttestationStale();
        }

        // Calculate new debt
        uint256 newDebt = vault.debtUsd + amountUsd;

        // Check health factor after mint
        uint256 hf = _calculateHealthFactor(vault.collateralSat, newDebt, vault.lastBtcPrice);
        if (hf < 100) {
            revert InsufficientCollateral();
        }

        // Update debt and mint
        vault.debtUsd = newDebt;
        btcUsd.mint(msg.sender, amountUsd);

        emit BtcUSDMinted(msg.sender, amountUsd, newDebt);
    }

    /**
     * @notice Repay btcUSD debt
     * @param amountUsd Amount to repay (18 decimals)
     */
    function repay(uint256 amountUsd) external {
        if (amountUsd == 0) revert ZeroAmount();

        Vault storage vault = vaults[msg.sender];
        if (vault.debtUsd == 0) revert NoDebtToRepay();

        // Cap repayment at actual debt
        uint256 actualRepay = amountUsd > vault.debtUsd ? vault.debtUsd : amountUsd;

        // Burn tokens and reduce debt
        btcUsd.burnFrom(msg.sender, actualRepay);
        vault.debtUsd -= actualRepay;

        emit BtcUSDRepaid(msg.sender, actualRepay, vault.debtUsd);
    }

    /**
     * @notice Liquidate an undercollateralized vault
     * @param user Address of the vault owner to liquidate
     */
    function liquidate(address user) external {
        Vault storage vault = vaults[user];

        uint256 hf = _calculateHealthFactor(vault.collateralSat, vault.debtUsd, vault.lastBtcPrice);
        if (hf >= 100) revert VaultHealthy();

        uint256 debtToLiquidate = vault.debtUsd;

        // Liquidator must have enough btcUSD to cover the debt
        btcUsd.burnFrom(msg.sender, debtToLiquidate);

        // Clear the vault (in a real system, collateral would be distributed to liquidator)
        // For hackathon: we just clear the debt and collateral record
        vault.debtUsd = 0;
        vault.collateralSat = 0;
        vault.active = false;

        emit VaultLiquidated(user, msg.sender, debtToLiquidate);
    }

    // ============ View Functions ============

    /**
     * @notice Calculate health factor for a user
     * @param user Address of the vault owner
     * @return Health factor (100 = exactly at MCR, >100 = safe, <100 = liquidatable)
     */
    function healthFactor(address user) external view returns (uint256) {
        Vault storage vault = vaults[user];
        return _calculateHealthFactor(vault.collateralSat, vault.debtUsd, vault.lastBtcPrice);
    }

    /**
     * @notice Check if a txid has already been attested
     * @param txid Bitcoin transaction ID
     * @return Whether the txid has been attested
     */
    function isAttested(bytes32 txid) external view returns (bool) {
        return attestedTxids[txid];
    }

    /**
     * @notice Get vault details for a user
     * @param user Address of the vault owner
     * @return collateralSat Total collateral in satoshis
     * @return debtUsd Total debt in btcUSD (18 decimals)
     * @return lastAttested Timestamp of last attestation
     * @return lastBtcPrice Last attested BTC price
     * @return active Whether vault is active
     */
    function getVault(address user)
        external
        view
        returns (uint256 collateralSat, uint256 debtUsd, uint256 lastAttested, uint256 lastBtcPrice, bool active)
    {
        Vault storage vault = vaults[user];
        return (vault.collateralSat, vault.debtUsd, vault.lastAttested, vault.lastBtcPrice, vault.active);
    }

    // ============ Internal Functions ============

    /**
     * @notice Calculate health factor
     * @dev hf = (collateral_usd * 10000) / (debt_usd * MCR)
     *      hf >= 100 means safe
     * @param collateralSat Collateral in satoshis
     * @param debtUsd Debt in btcUSD (18 decimals)
     * @param btcPriceUsd BTC price (8 decimals)
     * @return Health factor (100 = at MCR)
     */
    function _calculateHealthFactor(uint256 collateralSat, uint256 debtUsd, uint256 btcPriceUsd)
        internal
        pure
        returns (uint256)
    {
        if (debtUsd == 0) return type(uint256).max;

        // collateralUsd = (collateralSat * btcPriceUsd) / SATS_PER_BTC
        // Both have 8 decimals from Chainlink, result needs to be in 18 decimals like debt
        // btcPriceUsd is 8 decimals, collateralSat is in sats (8 decimal representation of BTC)
        // So collateralUsd = collateralSat * btcPriceUsd / 1e8 gives us 8 decimal USD
        // We need to scale to 18 decimals: multiply by 1e10
        uint256 collateralUsd = (collateralSat * btcPriceUsd * 1e10) / SATS_PER_BTC;

        // hf = (collateralUsd * 10000) / (debtUsd * MCR)
        // Result is basis points where 100 = exactly at MCR
        return (collateralUsd * 10000) / (debtUsd * MCR);
    }

    /// @notice Mint up to available vault capacity for the user.
    /// @dev Caps minting at the max debt allowed by MCR; returns actual minted amount.
    function _mintUpToCapacity(address user, uint256 requestedAmountUsd) internal returns (uint256 mintedAmountUsd) {
        Vault storage vault = vaults[user];
        if (requestedAmountUsd == 0) return 0;

        uint256 collateralUsd = (vault.collateralSat * vault.lastBtcPrice * 1e10) / SATS_PER_BTC;
        uint256 maxDebtUsd = (collateralUsd * 100) / MCR;
        if (maxDebtUsd <= vault.debtUsd) return 0;

        uint256 availableCapacity = maxDebtUsd - vault.debtUsd;
        mintedAmountUsd = requestedAmountUsd > availableCapacity ? availableCapacity : requestedAmountUsd;
        if (mintedAmountUsd == 0) return 0;

        vault.debtUsd += mintedAmountUsd;
        btcUsd.mint(user, mintedAmountUsd);

        emit BtcUSDMinted(user, mintedAmountUsd, vault.debtUsd);
    }

    /// @notice Execute liquidation triggered by a DON-signed liquidation report.
    /// @dev CDPCore is an authorized burner on BtcUSD — no depositor approval needed.
    function _applyLiquidation(address depositor) internal {
        Vault storage vault = vaults[depositor];

        if (!vault.active || vault.debtUsd == 0) return;

        uint256 hf = _calculateHealthFactor(vault.collateralSat, vault.debtUsd, vault.lastBtcPrice);
        if (hf >= 100) revert VaultHealthy();

        uint256 debtToLiquidate = vault.debtUsd;

        // CDPCore holds the burner role on BtcUSD — burn depositor's tokens directly
        btcUsd.burnFrom(depositor, debtToLiquidate);

        vault.debtUsd = 0;
        vault.collateralSat = 0;
        vault.active = false;

        emit VaultLiquidated(depositor, address(this), debtToLiquidate);
    }

    function _applySnapshot(VaultSnapshotReportV3 memory snapshot) internal {
        Vault storage vault = vaults[snapshot.depositor];
        uint256 previousCollateral = vault.collateralSat;

        vault.collateralSat = snapshot.collateralSat;
        vault.lastBtcPrice = snapshot.btcPriceUsd;
        vault.lastAttested = snapshot.timestamp;
        vault.active = snapshot.collateralSat > 0 || vault.debtUsd > 0;

        emit VaultSnapshotSynced(
            snapshot.depositor, previousCollateral, snapshot.collateralSat, snapshot.btcPriceUsd, snapshot.timestamp
        );

        if (snapshot.mintAmountUsd > 0) {
            uint256 mintedAmount = _mintUpToCapacity(snapshot.depositor, snapshot.mintAmountUsd);
            emit AutoMintOnAttestation(snapshot.depositor, snapshot.mintAmountUsd, mintedAmount, vault.debtUsd);
        }
    }
}
