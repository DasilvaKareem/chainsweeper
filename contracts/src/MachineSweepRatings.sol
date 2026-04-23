// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title MachineSweepRatings — address-keyed ELO for MachineSweep
/// @notice Separate contract so ratings survive match-contract upgrades.
///         Only the configured match contract can write; anyone can read.
contract MachineSweepRatings {
    /// @dev 1200 starting rating is the ELO convention — same as chess.
    uint32 public constant STARTING_RATING = 1200;
    /// @dev Higher K for unsettled players; swaps to standard K after 10 games.
    uint8 public constant K_PROVISIONAL = 32;
    uint8 public constant K_STANDARD = 16;
    uint8 public constant PROVISIONAL_GAMES = 10;

    struct Player {
        uint32 rating;
        uint32 matchesPlayed;
        uint32 wins;
        uint32 losses;
    }

    mapping(address => Player) public players;

    address public immutable matchContract;

    event RatingChanged(
        address indexed player,
        uint32 oldRating,
        uint32 newRating,
        bool won,
        uint32 matchesPlayed
    );

    error OnlyMatch();

    constructor(address _matchContract) {
        matchContract = _matchContract;
    }

    /// @notice Apply an ELO update for a completed match.
    /// @dev Intentionally cannot revert for rating math — callers rely on
    ///      settle being a non-failing side effect of match end. Any revert
    ///      here would brick match termination.
    function settle(address winner, address loser) external {
        if (msg.sender != matchContract) revert OnlyMatch();
        if (winner == address(0) || loser == address(0) || winner == loser) return;

        Player storage wP = players[winner];
        Player storage lP = players[loser];
        uint32 wR = wP.rating == 0 ? STARTING_RATING : wP.rating;
        uint32 lR = lP.rating == 0 ? STARTING_RATING : lP.rating;

        (uint32 newW, uint32 newL) = _apply(wR, lR, wP.matchesPlayed, lP.matchesPlayed);

        wP.rating = newW;
        lP.rating = newL;
        unchecked {
            wP.matchesPlayed += 1;
            lP.matchesPlayed += 1;
            wP.wins += 1;
            lP.losses += 1;
        }

        emit RatingChanged(winner, wR, newW, true, wP.matchesPlayed);
        emit RatingChanged(loser, lR, newL, false, lP.matchesPlayed);
    }

    function getRating(address who) external view returns (uint32) {
        uint32 r = players[who].rating;
        return r == 0 ? STARTING_RATING : r;
    }

    // ---- Internal ELO math -----------------------------------------------

    /// @dev Computes expected-score * 1000 for the winner given their rating
    ///      delta vs the loser. Uses a precomputed table because Solidity has
    ///      no fp and computing 10^(x/400) on-chain is absurdly expensive. The
    ///      table is keyed by delta bucketed to 100 points, clamped to ±800.
    function _expectedScoreX1000(int256 delta) internal pure returns (uint32) {
        // E_A = 1 / (1 + 10^((R_opp - R_self) / 400))
        // Values below are 1000 * E_A at bucket midpoints. Symmetric: a negative
        // delta for the winner means they were the favourite (rare but happens
        // if an unranked player beats someone stronger).
        int256 d = delta;
        if (d > 800) d = 800;
        if (d < -800) d = -800;
        int256 idx = (d + 800) / 100; // 0..16

        uint32[17] memory table = [
            uint32(10),  uint32(17),  uint32(31),  uint32(53),  uint32(91),   //  -800..-400
            uint32(151), uint32(240), uint32(360), uint32(500),               //  -300..   0
            uint32(640), uint32(760), uint32(849), uint32(909),               //   100.. 400
            uint32(947), uint32(969), uint32(983), uint32(990)                //   500.. 800
        ];
        return table[uint256(idx)];
    }

    function _kFactor(uint32 matchesPlayed) internal pure returns (uint32) {
        return matchesPlayed < PROVISIONAL_GAMES ? K_PROVISIONAL : K_STANDARD;
    }

    /// @dev Decisive W/L only — no draws for MVP. If we add draw support
    ///      (forfeit/timeout tied scores), pass in actual scores 0..1000 and
    ///      adjust the deltas proportionally.
    function _apply(
        uint32 wR,
        uint32 lR,
        uint32 wMatches,
        uint32 lMatches
    ) internal pure returns (uint32 newW, uint32 newL) {
        int256 delta = int256(uint256(wR)) - int256(uint256(lR));
        uint32 eW = _expectedScoreX1000(delta);
        // winner actual score = 1000; loser = 0. Update = K * (S - E) / 1000.
        uint32 kW = _kFactor(wMatches);
        uint32 kL = _kFactor(lMatches);

        // Winner gains K * (1 - E), loser loses K * E.
        // Ratings clamped to [100, 3000] so a cold-start cascade can't push a
        // new account below zero via uint underflow.
        uint256 gainW = (uint256(kW) * (1000 - eW)) / 1000;
        uint256 lossL = (uint256(kL) * (1000 - (1000 - eW))) / 1000; // == kL * eW / 1000

        newW = _clamp(uint256(wR) + gainW);
        newL = _clamp(uint256(lR) > lossL ? uint256(lR) - lossL : 0);
    }

    function _clamp(uint256 r) internal pure returns (uint32) {
        if (r < 100) return 100;
        if (r > 3000) return 3000;
        return uint32(r);
    }
}
