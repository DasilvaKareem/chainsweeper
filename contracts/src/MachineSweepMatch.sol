// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IBiteSupplicant } from "@skalenetwork/bite-solidity/interfaces/IBiteSupplicant.sol";
import { BITE } from "@skalenetwork/bite-solidity/BITE.sol";

/// @notice ELO update hook — see MachineSweepRatings.
interface IRatings {
    function settle(address winner, address loser) external;
}

/// @title MachineSweepMatch
/// @notice On-chain authority for multiplayer MachineSweep. Per-cell BITE
///         ciphertexts hide the core positions; reveals execute as CTXs so
///         neither player (nor the host) can peek at unrevealed cells.
///         Realtime UX (timer, chat, markers, presence) lives off-chain in
///         the Cloudflare DO — this contract is authoritative only for
///         anything derived from the hidden mine layout.
///
/// @dev BITE V2 flow (confirmed against bite-solidity@main):
///      1. reveal() packs (matchId, x, y) into plaintextArguments and the
///         cell's ciphertext into encryptedArguments, then calls
///         `BITE.submitCTX(...)` which returns a `callbackSender` — a
///         per-CTX CallbackSender contract the precompile mints.
///      2. The caller (this contract) funds the callbackSender with
///         `CTX_GAS_PAYMENT` so the eventual `sendCallback` has gas to
///         execute our onDecrypt.
///      3. We record the callbackSender in `pendingCallback` so onDecrypt
///         can verify msg.sender against a known-legitimate CTX.
///      4. BITE threshold-decrypts; CallbackSender invokes `onDecrypt` with
///         (decryptedArguments, plaintextArguments). We decode context from
///         plaintext, verify the sender, and apply the reveal.
///
///      Per-cell ciphertext shape: encrypted `abi.encode(bool isCore, uint8 adjacency)`.
///      Packing both in one blob = one BITE decrypt per reveal, not two.
contract MachineSweepMatch is IBiteSupplicant {
    // ------------------------------------------------------------------ config

    /// @dev BITE sandbox 2 charges this per CTX — funds the CallbackSender so
    ///      it has balance for its eventual onDecrypt call.
    uint256 public constant CTX_GAS_PAYMENT = 0.06 ether;

    /// @dev Gas budget the CallbackSender allots to our onDecrypt. The body
    ///      does a handful of storage writes + at most an external call into
    ///      ratings.settle; 2.5M matches the bite skill's guidance.
    uint256 public constant CTX_GAS_LIMIT = 2_500_000;

    uint8 public constant MAX_HEALTH = 3;

    // ------------------------------------------------------------------- types

    enum Status { Pending, Playing, Ended }

    struct Match {
        address host;           // seat 0
        address guest;          // seat 1
        uint8 width;
        uint8 height;
        uint16 coreCount;
        uint16 safeRemaining;
        uint8 currentPlayer;
        uint8 winner;
        uint8 hostHealth;
        uint8 guestHealth;
        uint16 hostScore;
        uint16 guestScore;
        Status status;
    }

    struct Cell {
        uint8 state;            // 0 hidden, 1 safe, 2 core
        uint8 adjacency;
        uint8 revealedBy;
    }

    // ------------------------------------------------------------------ state

    IRatings public immutable ratings;

    mapping(bytes32 => Match) public matches;
    mapping(bytes32 => mapping(uint16 => Cell)) public cells;
    mapping(bytes32 => mapping(uint16 => bytes)) public cipherCells;

    /// @notice Known-legitimate CallbackSender addresses, set when submitCTX
    ///         returns and cleared on onDecrypt. Our ACL: onDecrypt rejects
    ///         any sender not in this set.
    mapping(address => bool) public pendingCallback;

    // ------------------------------------------------------------------ events

    event MatchCreated(
        bytes32 indexed matchId,
        address indexed host,
        uint8 width,
        uint8 height,
        uint16 coreCount
    );
    event PlayerJoined(bytes32 indexed matchId, address indexed guest);
    event RevealRequested(
        bytes32 indexed matchId,
        uint8 player,
        uint8 x,
        uint8 y,
        address callbackSender
    );
    event Revealed(
        bytes32 indexed matchId,
        uint8 player,
        uint8 x,
        uint8 y,
        bool wasCore,
        uint8 adjacency
    );
    event HealthChanged(bytes32 indexed matchId, uint8 player, uint8 health);
    event MatchEnded(bytes32 indexed matchId, address indexed winner, uint8 winnerSeat);

    // ------------------------------------------------------------------ errors

    error MatchExists();
    error MatchFull();
    error SelfJoin();
    error NoMatch();
    error NotPlaying();
    error NotYourTurn();
    error OutOfBounds();
    error AlreadyRevealed();
    error InsufficientCtxFee();
    error BadConfig();
    error FundCallbackFailed();
    error RefundFailed();
    error UnknownCallback();
    error MalformedCtx();

    // ------------------------------------------------------------ constructor

    constructor(address _ratings) {
        ratings = IRatings(_ratings);
    }

    // ------------------------------------------------------------- lifecycle

    function createMatch(
        bytes32 matchId,
        uint8 width,
        uint8 height,
        uint16 coreCount,
        bytes[] calldata cipher
    ) external {
        if (matchId == bytes32(0)) revert BadConfig();
        if (matches[matchId].host != address(0)) revert MatchExists();
        uint256 size = uint256(width) * uint256(height);
        if (
            width < 4 || height < 4 || width > 32 || height > 32 ||
            coreCount == 0 || uint256(coreCount) >= size ||
            cipher.length != size
        ) revert BadConfig();

        Match storage m = matches[matchId];
        m.host = msg.sender;
        m.width = width;
        m.height = height;
        m.coreCount = coreCount;
        m.safeRemaining = uint16(size - coreCount);
        m.currentPlayer = 0;
        m.status = Status.Pending;
        m.hostHealth = MAX_HEALTH;
        m.guestHealth = MAX_HEALTH;

        for (uint16 i = 0; i < size; i++) {
            cipherCells[matchId][i] = cipher[i];
        }

        emit MatchCreated(matchId, msg.sender, width, height, coreCount);
    }

    function joinMatch(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.host == address(0)) revert NoMatch();
        if (m.guest != address(0)) revert MatchFull();
        if (m.host == msg.sender) revert SelfJoin();
        m.guest = msg.sender;
        m.status = Status.Playing;
        emit PlayerJoined(matchId, msg.sender);
    }

    // ----------------------------------------------------------------- reveal

    /// @notice Current player submits a reveal for (x,y). Pays the CTX fee,
    ///         submits the ciphertext to BITE, and funds the returned
    ///         CallbackSender so it can later invoke our onDecrypt.
    /// @dev    Does NOT mutate the board — that happens in onDecrypt when BITE
    ///         returns the plaintext. Treat the in-flight window as a UI
    ///         pending state on the client.
    function reveal(bytes32 matchId, uint8 x, uint8 y) external payable {
        Match storage m = matches[matchId];
        if (m.status != Status.Playing) revert NotPlaying();
        if (msg.value < CTX_GAS_PAYMENT) revert InsufficientCtxFee();

        address actor = m.currentPlayer == 0 ? m.host : m.guest;
        if (msg.sender != actor) revert NotYourTurn();
        if (x >= m.width || y >= m.height) revert OutOfBounds();

        uint16 cellIdx = uint16(y) * uint16(m.width) + uint16(x);
        if (cells[matchId][cellIdx].state != 0) revert AlreadyRevealed();

        // Plaintext args carry the context (matchId, x, y) through unchanged
        // — BITE doesn't encrypt them, but they ride along so onDecrypt can
        // correlate without extra state tracking.
        bytes[] memory encArgs = new bytes[](1);
        encArgs[0] = cipherCells[matchId][cellIdx];
        bytes[] memory ptArgs = new bytes[](1);
        ptArgs[0] = abi.encode(matchId, x, y, m.currentPlayer);

        address callbackSender = BITE.submitCTX(
            BITE.SUBMIT_CTX_ADDRESS,
            CTX_GAS_LIMIT,
            encArgs,
            ptArgs
        );
        pendingCallback[callbackSender] = true;

        // Fund the per-CTX CallbackSender so it has balance to execute the
        // eventual sendCallback → onDecrypt chain. Amount must cover
        // CTX_GAS_LIMIT * tx.gasprice at callback time; 0.06 ETH is the
        // headline sandbox figure and should be generous at typical prices.
        (bool funded, ) = payable(callbackSender).call{ value: CTX_GAS_PAYMENT }("");
        if (!funded) revert FundCallbackFailed();

        emit RevealRequested(matchId, m.currentPlayer, x, y, callbackSender);

        // Refund caller overpay so a loose frontend can't brick itself.
        uint256 excess = msg.value - CTX_GAS_PAYMENT;
        if (excess > 0) {
            (bool r, ) = msg.sender.call{ value: excess }("");
            if (!r) revert RefundFailed();
        }
    }

    /// @inheritdoc IBiteSupplicant
    /// @dev ACL: msg.sender must be a CallbackSender we just funded. Single-
    ///      use; we delete the entry on arrival to block replay.
    function onDecrypt(
        bytes[] calldata decryptedArguments,
        bytes[] calldata plaintextArguments
    ) external override {
        if (!pendingCallback[msg.sender]) revert UnknownCallback();
        delete pendingCallback[msg.sender];

        if (decryptedArguments.length != 1 || plaintextArguments.length != 1) {
            revert MalformedCtx();
        }

        (bytes32 matchId, uint8 x, uint8 y, uint8 player) = abi.decode(
            plaintextArguments[0],
            (bytes32, uint8, uint8, uint8)
        );

        Match storage m = matches[matchId];
        if (m.status != Status.Playing) return; // ended mid-flight — drop

        uint16 cellIdx = uint16(y) * uint16(m.width) + uint16(x);
        Cell storage c = cells[matchId][cellIdx];
        // Defensive: same-cell double-reveals shouldn't happen (reveal() blocks
        // via AlreadyRevealed) but guard in case of a protocol change.
        if (c.state != 0) return;

        (bool isCore, uint8 adjacency) = abi.decode(decryptedArguments[0], (bool, uint8));

        c.state = isCore ? 2 : 1;
        c.adjacency = adjacency;
        c.revealedBy = player;

        emit Revealed(matchId, player, x, y, isCore, adjacency);

        if (isCore) {
            if (player == 0) {
                m.hostHealth -= 1;
                emit HealthChanged(matchId, 0, m.hostHealth);
                if (m.hostHealth == 0) { _finalize(matchId, 1); return; }
            } else {
                m.guestHealth -= 1;
                emit HealthChanged(matchId, 1, m.guestHealth);
                if (m.guestHealth == 0) { _finalize(matchId, 0); return; }
            }
        } else {
            if (player == 0) m.hostScore += 1;
            else m.guestScore += 1;
            m.safeRemaining -= 1;
            if (m.safeRemaining == 0) {
                uint8 seat = m.hostScore >= m.guestScore ? 0 : 1;
                _finalize(matchId, seat);
                return;
            }
        }

        m.currentPlayer = player == 0 ? 1 : 0;
    }

    // --------------------------------------------------------------- internals

    function _finalize(bytes32 matchId, uint8 winnerSeat) internal {
        Match storage m = matches[matchId];
        m.status = Status.Ended;
        m.winner = winnerSeat;
        address winner = winnerSeat == 0 ? m.host : m.guest;
        address loser = winnerSeat == 0 ? m.guest : m.host;
        emit MatchEnded(matchId, winner, winnerSeat);
        ratings.settle(winner, loser);
    }

    // ------------------------------------------------------------------ views

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getCell(bytes32 matchId, uint8 x, uint8 y) external view returns (Cell memory) {
        Match storage m = matches[matchId];
        uint16 cellIdx = uint16(y) * uint16(m.width) + uint16(x);
        return cells[matchId][cellIdx];
    }
}
