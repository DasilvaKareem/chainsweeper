// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MinimalERC1155 } from "./MinimalERC1155.sol";
import { IMachineSweepRepairs } from "./IMachineSweepRepairs.sol";

/// @title MachineSweepRepairs — Repair Items (ERC-1155) for Territories mode
/// @notice One item id for MVP: REPAIR_CORE (id 1). Burn one to reset a
///         Corrupted plot back to Uncleared. Acquired by (a) buying from the
///         protocol at 3x plot price, or (b) perfect-clearing a plot, which
///         the Plots contract mints via `mintReward`.
contract MachineSweepRepairs is MinimalERC1155, IMachineSweepRepairs {
    uint256 public constant REPAIR_CORE = 1;

    /// @notice Price in native SKALE per Repair Item, set at deploy.
    uint256 public immutable REPAIR_PRICE;

    address public immutable TREASURY;
    address public immutable PLOTS;

    error InsufficientPayment();
    error OnlyPlots();
    error TreasuryTransferFailed();
    error RefundFailed();

    constructor(
        address plots,
        uint256 repairPrice,
        address treasury,
        string memory uri_
    ) MinimalERC1155(uri_) {
        PLOTS = plots;
        REPAIR_PRICE = repairPrice;
        TREASURY = treasury;
    }

    modifier onlyPlots() {
        if (msg.sender != PLOTS) revert OnlyPlots();
        _;
    }

    /// @notice Buy N Repair Items from the protocol. Payment flows to treasury.
    function buyFromProtocol(uint256 amount) external payable {
        uint256 owed = REPAIR_PRICE * amount;
        if (msg.value < owed) revert InsufficientPayment();

        _mint(msg.sender, REPAIR_CORE, amount);

        (bool ok, ) = payable(TREASURY).call{ value: owed }("");
        if (!ok) revert TreasuryTransferFailed();

        uint256 excess = msg.value - owed;
        if (excess > 0) {
            (bool r, ) = msg.sender.call{ value: excess }("");
            if (!r) revert RefundFailed();
        }
    }

    /// @inheritdoc IMachineSweepRepairs
    function mintReward(address to, uint256 amount) external onlyPlots {
        _mint(to, REPAIR_CORE, amount);
    }

    /// @inheritdoc IMachineSweepRepairs
    function burnForRepair(address from, uint256 amount) external onlyPlots {
        _burn(from, REPAIR_CORE, amount);
    }
}
