// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal interface MachineSweepPlots needs from the Repairs token.
///         Implemented by MachineSweepRepairs; kept separate so Plots can be
///         deployed and tested without the full ERC-1155 surface.
interface IMachineSweepRepairs {
    function mintReward(address to, uint256 amount) external;
    function burnForRepair(address from, uint256 amount) external;
}
