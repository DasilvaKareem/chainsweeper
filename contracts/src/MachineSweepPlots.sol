// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBiteSupplicant } from "@skalenetwork/bite-solidity/interfaces/IBiteSupplicant.sol";
import { BITE } from "@skalenetwork/bite-solidity/BITE.sol";
import { MinimalERC721 } from "./MinimalERC721.sol";

import { IMachineSweepRepairs } from "./IMachineSweepRepairs.sol";

/// @title MachineSweepPlots — infinite-grid plot NFTs (Territories mode)
/// @notice Each plot is an 8x8 minesweeper board minted as an ERC-721 at fixed
///         (plotX, plotY) coords. Cores are hidden via BITE CTX (same pattern
///         as MachineSweepMatch). Hit a core -> plot becomes Corrupted and
///         locks; burn a Repair Item to regenerate the board and replay.
///
/// @dev    tokenId = uint256(keccak256(abi.encode(plotX, plotY))). Coords are
///         int64 so players can buy far out on the grid. 8x8 fixed size lets
///         us pack a cell index into uint8 and avoid dynamic-size bookkeeping.
contract MachineSweepPlots is MinimalERC721, IBiteSupplicant {
    // ------------------------------------------------------------------ config

    uint8 public constant WIDTH = 8;
    uint8 public constant HEIGHT = 8;
    uint16 public constant CELL_COUNT = 64;
    uint8 public constant CORE_COUNT = 10;

    /// @dev Mirrors MachineSweepMatch — sandbox 2 sets the CTX fee; generous
    ///      gas limit for onDecrypt which may touch status + reward mint.
    uint256 public constant CTX_GAS_PAYMENT = 0.06 ether;
    uint256 public constant CTX_GAS_LIMIT = 2_500_000;

    /// @notice Fixed mint price in native SKALE token. Deploy-time immutable.
    uint256 public immutable PLOT_PRICE;

    /// @notice Treasury receiving mint + repair mint proceeds.
    address public immutable TREASURY;

    // ------------------------------------------------------------------ types

    enum Status { Uncleared, Cleared, Corrupted }

    struct Plot {
        int64 x;
        int64 y;
        Status status;
        uint8 safeRemaining;
        uint64 mintedAt;
        address lastPlayer;
    }

    struct Cell {
        uint8 state;        // 0 hidden, 1 safe, 2 core
        uint8 adjacency;
    }

    // ------------------------------------------------------------------- state

    IMachineSweepRepairs public repairs;
    address public immutable DEPLOYER;

    mapping(uint256 => Plot) public plots;
    mapping(uint256 => mapping(uint16 => Cell)) public cells;
    mapping(uint256 => mapping(uint16 => bytes)) public cipherCells;

    /// @notice keccak256(plotX,plotY) -> tokenId; used to enforce "one token
    ///         per coord" cheaply without iterating _owners.
    mapping(bytes32 => uint256) public coordToToken;

    /// @notice Same ACL pattern as MachineSweepMatch: track live CallbackSenders.
    mapping(address => uint256) public pendingToken;
    mapping(address => bool) public pendingActive;

    // ------------------------------------------------------------------- events

    event PlotMinted(uint256 indexed tokenId, address indexed owner, int64 x, int64 y);
    event RevealRequested(uint256 indexed tokenId, uint8 x, uint8 y, address callbackSender);
    event CellRevealed(uint256 indexed tokenId, uint8 x, uint8 y, bool wasCore, uint8 adjacency);
    event PlotCleared(uint256 indexed tokenId, address indexed owner);
    event PlotCorrupted(uint256 indexed tokenId, address indexed owner, uint8 mineX, uint8 mineY);
    event PlotRepaired(uint256 indexed tokenId, address indexed owner);

    // ------------------------------------------------------------------- errors

    error CoordTaken();
    error BadCipherLength();
    error NotOwner();
    error OutOfBounds();
    error AlreadyRevealed();
    error NotPlayable();
    error NotCorrupted();
    error InsufficientCtxFee();
    error InsufficientMint();
    error FundCallbackFailed();
    error RefundFailed();
    error TreasuryTransferFailed();
    error UnknownCallback();
    error MalformedCtx();
    error RepairsAlreadySet();
    error OnlyDeployer();

    // ------------------------------------------------------------------- init

    constructor(uint256 plotPrice, address treasury)
        MinimalERC721("MachineSweep Plot", "MSPLOT")
    {
        PLOT_PRICE = plotPrice;
        TREASURY = treasury;
        DEPLOYER = msg.sender;
    }

    /// @notice One-shot wire-up of the Repairs contract. Separate from the
    ///         constructor to break the deploy-order cycle (Repairs needs the
    ///         Plots address; Plots needs the Repairs address).
    function setRepairs(address repairsAddr) external {
        if (msg.sender != DEPLOYER) revert OnlyDeployer();
        if (address(repairs) != address(0)) revert RepairsAlreadySet();
        repairs = IMachineSweepRepairs(repairsAddr);
    }

    // ---------------------------------------------------------------- minting

    /// @notice Mint a fresh plot at (x, y). Caller supplies the per-cell BITE
    ///         ciphertexts (each encrypts `abi.encode(bool isCore, uint8 adjacency)`).
    ///         Client is trusted to produce a valid board — a dishonest client
    ///         only hurts themselves (fewer mines = easier plot but no reward
    ///         asymmetry, more mines = impossible plot).
    function mintPlot(int64 x, int64 y, bytes[] calldata cipher) external payable {
        if (msg.value < PLOT_PRICE) revert InsufficientMint();
        if (cipher.length != CELL_COUNT) revert BadCipherLength();

        bytes32 coordKey = keccak256(abi.encode(x, y));
        if (coordToToken[coordKey] != 0) revert CoordTaken();

        uint256 tokenId = uint256(coordKey);
        coordToToken[coordKey] = tokenId;

        Plot storage p = plots[tokenId];
        p.x = x;
        p.y = y;
        p.status = Status.Uncleared;
        p.safeRemaining = uint8(CELL_COUNT - CORE_COUNT);
        p.mintedAt = uint64(block.timestamp);

        for (uint16 i = 0; i < CELL_COUNT; i++) {
            cipherCells[tokenId][i] = cipher[i];
        }

        _safeMint(msg.sender, tokenId);
        emit PlotMinted(tokenId, msg.sender, x, y);

        _payTreasury(PLOT_PRICE);
        _refundExcess(msg.value - PLOT_PRICE);
    }

    // ---------------------------------------------------------------- reveal

    /// @notice Owner submits a reveal for (x, y). Same BITE CTX dance as
    ///         MachineSweepMatch.reveal. onDecrypt mutates state.
    function revealCell(uint256 tokenId, uint8 x, uint8 y) external payable {
        if (_ownerOf(tokenId) != msg.sender) revert NotOwner();
        Plot storage p = plots[tokenId];
        if (p.status != Status.Uncleared) revert NotPlayable();
        if (x >= WIDTH || y >= HEIGHT) revert OutOfBounds();
        if (msg.value < CTX_GAS_PAYMENT) revert InsufficientCtxFee();

        uint16 idx = _cellIdx(x, y);
        if (cells[tokenId][idx].state != 0) revert AlreadyRevealed();

        p.lastPlayer = msg.sender;

        bytes[] memory encArgs = new bytes[](1);
        encArgs[0] = cipherCells[tokenId][idx];
        bytes[] memory ptArgs = new bytes[](1);
        ptArgs[0] = abi.encode(tokenId, x, y);

        address callbackSender = BITE.submitCTX(
            BITE.SUBMIT_CTX_ADDRESS,
            CTX_GAS_LIMIT,
            encArgs,
            ptArgs
        );
        pendingActive[callbackSender] = true;
        pendingToken[callbackSender] = tokenId;

        (bool funded, ) = payable(callbackSender).call{ value: CTX_GAS_PAYMENT }("");
        if (!funded) revert FundCallbackFailed();

        emit RevealRequested(tokenId, x, y, callbackSender);

        _refundExcess(msg.value - CTX_GAS_PAYMENT);
    }

    /// @inheritdoc IBiteSupplicant
    function onDecrypt(
        bytes[] calldata decryptedArguments,
        bytes[] calldata plaintextArguments
    ) external override {
        if (!pendingActive[msg.sender]) revert UnknownCallback();
        delete pendingActive[msg.sender];
        delete pendingToken[msg.sender];

        if (decryptedArguments.length != 1 || plaintextArguments.length != 1) {
            revert MalformedCtx();
        }

        (uint256 tokenId, uint8 x, uint8 y) = abi.decode(
            plaintextArguments[0],
            (uint256, uint8, uint8)
        );

        Plot storage p = plots[tokenId];
        // Plot may have been repaired or otherwise no longer in play; drop silently.
        if (p.status != Status.Uncleared) return;

        uint16 idx = _cellIdx(x, y);
        Cell storage c = cells[tokenId][idx];
        if (c.state != 0) return;

        (bool isCore, uint8 adjacency) = abi.decode(decryptedArguments[0], (bool, uint8));
        c.state = isCore ? 2 : 1;
        c.adjacency = adjacency;

        emit CellRevealed(tokenId, x, y, isCore, adjacency);

        address owner = _ownerOf(tokenId);
        if (isCore) {
            p.status = Status.Corrupted;
            emit PlotCorrupted(tokenId, owner, x, y);
        } else {
            unchecked { p.safeRemaining -= 1; }
            if (p.safeRemaining == 0) {
                p.status = Status.Cleared;
                emit PlotCleared(tokenId, owner);
                // Perfect-clear reward: 1 Repair Item. Fixed 100% for MVP —
                // tune later by making this probabilistic.
                if (address(repairs) != address(0)) {
                    repairs.mintReward(owner, 1);
                }
            }
        }
    }

    // ----------------------------------------------------------------- repair

    /// @notice Burn 1 Repair Item and supply a fresh cipher board to reset a
    ///         corrupted plot. Ownership unchanged; history wiped. New plot is
    ///         Uncleared again.
    function repairPlot(uint256 tokenId, bytes[] calldata cipher) external {
        if (_ownerOf(tokenId) != msg.sender) revert NotOwner();
        Plot storage p = plots[tokenId];
        if (p.status != Status.Corrupted) revert NotCorrupted();
        if (cipher.length != CELL_COUNT) revert BadCipherLength();

        repairs.burnForRepair(msg.sender, 1);

        for (uint16 i = 0; i < CELL_COUNT; i++) {
            delete cells[tokenId][i];
            cipherCells[tokenId][i] = cipher[i];
        }
        p.status = Status.Uncleared;
        p.safeRemaining = uint8(CELL_COUNT - CORE_COUNT);

        emit PlotRepaired(tokenId, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function getPlot(uint256 tokenId) external view returns (Plot memory) {
        return plots[tokenId];
    }

    function getCell(uint256 tokenId, uint8 x, uint8 y) external view returns (Cell memory) {
        return cells[tokenId][_cellIdx(x, y)];
    }

    function tokenIdFor(int64 x, int64 y) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(x, y)));
    }

    // --------------------------------------------------------------- internal

    function _cellIdx(uint8 x, uint8 y) internal pure returns (uint16) {
        return uint16(y) * uint16(WIDTH) + uint16(x);
    }

    function _payTreasury(uint256 amount) internal {
        (bool ok, ) = payable(TREASURY).call{ value: amount }("");
        if (!ok) revert TreasuryTransferFailed();
    }

    function _refundExcess(uint256 excess) internal {
        if (excess == 0) return;
        (bool r, ) = msg.sender.call{ value: excess }("");
        if (!r) revert RefundFailed();
    }
}
