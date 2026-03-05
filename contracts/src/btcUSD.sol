// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IBurnMintERC20
 * @notice Interface for CCIP TokenPool compatibility (burn-and-mint bridging)
 */
interface IBurnMintERC20 is IERC20 {
    function mint(address account, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

/**
 * @title BtcUSD
 * @notice Bitcoin-backed stablecoin with CCIP burn-and-mint bridging support.
 * @dev CDPCore can mint/burn for CDP operations.
 *      CCIP TokenPools can mint/burn for cross-chain bridging.
 */
contract BtcUSD is ERC20, ERC20Burnable, Ownable, IERC165 {
    // CDPCore address (can mint/burn for CDP operations)
    address public cdpCore;

    // Authorized minters (CDPCore + CCIP TokenPools)
    mapping(address => bool) private _minters;

    // Authorized burners (CDPCore + CCIP TokenPools)
    mapping(address => bool) private _burners;

    // ============ Events ============

    event CDPCoreSet(address indexed cdpCore);
    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event BurnerAdded(address indexed burner);
    event BurnerRemoved(address indexed burner);

    // ============ Errors ============

    error OnlyMinter();
    error OnlyBurner();
    error ZeroAddress();

    // ============ Modifiers ============

    modifier onlyMinter() {
        _checkMinter();
        _;
    }

    modifier onlyBurner() {
        _checkBurner();
        _;
    }

    function _checkMinter() internal view {
        if (!_minters[msg.sender]) revert OnlyMinter();
    }

    function _checkBurner() internal view {
        if (!_burners[msg.sender]) revert OnlyBurner();
    }

    // ============ Constructor ============

    constructor() ERC20("Bitcoin USD", "btcUSD") Ownable(msg.sender) {}

    // ============ Admin Functions ============

    /**
     * @notice Set the CDPCore contract address and grant it mint/burn roles.
     * @param _cdpCore The CDPCore contract address
     */
    function setCdpCore(address _cdpCore) external onlyOwner {
        if (_cdpCore == address(0)) revert ZeroAddress();

        // Remove old CDPCore roles if set
        if (cdpCore != address(0)) {
            _minters[cdpCore] = false;
            _burners[cdpCore] = false;
        }

        cdpCore = _cdpCore;
        _minters[_cdpCore] = true;
        _burners[_cdpCore] = true;

        emit CDPCoreSet(_cdpCore);
        emit MinterAdded(_cdpCore);
        emit BurnerAdded(_cdpCore);
    }

    /**
     * @notice Grant mint role to an address (e.g., CCIP TokenPool)
     */
    function grantMintRole(address minter) external onlyOwner {
        if (minter == address(0)) revert ZeroAddress();
        _minters[minter] = true;
        emit MinterAdded(minter);
    }

    /**
     * @notice Revoke mint role from an address
     */
    function revokeMintRole(address minter) external onlyOwner {
        _minters[minter] = false;
        emit MinterRemoved(minter);
    }

    /**
     * @notice Grant burn role to an address (e.g., CCIP TokenPool)
     */
    function grantBurnRole(address burner) external onlyOwner {
        if (burner == address(0)) revert ZeroAddress();
        _burners[burner] = true;
        emit BurnerAdded(burner);
    }

    /**
     * @notice Revoke burn role from an address
     */
    function revokeBurnRole(address burner) external onlyOwner {
        _burners[burner] = false;
        emit BurnerRemoved(burner);
    }

    /**
     * @notice Grant both mint and burn roles (convenience for CCIP TokenPools)
     */
    function grantMintAndBurnRoles(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _minters[account] = true;
        _burners[account] = true;
        emit MinterAdded(account);
        emit BurnerAdded(account);
    }

    // ============ View Functions ============

    function isMinter(address account) external view returns (bool) {
        return _minters[account];
    }

    function isBurner(address account) external view returns (bool) {
        return _burners[account];
    }

    // ============ Mint/Burn Functions ============

    /**
     * @notice Mint tokens. Called by CDPCore or CCIP TokenPool.
     * @param account Address to receive tokens
     * @param amount Amount to mint
     */
    function mint(address account, uint256 amount) external onlyMinter {
        _mint(account, amount);
    }

    /**
     * @notice Burn tokens from account. Called by CDPCore or CCIP TokenPool.
     * @dev Overrides ERC20Burnable. Used for CCIP burn-and-mint bridging.
     * @param account Address to burn from
     * @param amount Amount to burn
     */
    function burnFrom(address account, uint256 amount) public override onlyBurner {
        _burn(account, amount);
    }

    /**
     * @notice Burn tokens from caller (standard ERC20Burnable)
     * @dev Anyone can burn their own tokens
     */
    function burn(uint256 amount) public override {
        _burn(msg.sender, amount);
    }

    // ============ IERC165 ============

    /**
     * @notice ERC165 interface support for CCIP TokenPool compatibility
     */
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IERC20).interfaceId || interfaceId == type(IBurnMintERC20).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
