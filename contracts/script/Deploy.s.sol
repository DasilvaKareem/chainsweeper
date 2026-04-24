// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { MachineSweepRatings } from "../src/MachineSweepRatings.sol";
import { MachineSweepMatch } from "../src/MachineSweepMatch.sol";
import { MachineSweepPlots } from "../src/MachineSweepPlots.sol";
import { MachineSweepRepairs } from "../src/MachineSweepRepairs.sol";
import { MachineSweepMarketplace } from "../src/MachineSweepMarketplace.sol";

/// @title Deploy — one-shot deploy of all MachineSweep contracts to SKALE Base Sepolia
///
/// @dev Resolves two deploy cycles:
///   1. Ratings.matchContract and Match.ratings are BOTH immutable. We predict
///      the Match address using the deployer's current nonce + 1, hand it to
///      Ratings at construction, then deploy Match. Asserts the prediction.
///   2. Plots.repairs / Repairs.PLOTS form a circular dep. Plots exposes a
///      one-shot setRepairs() setter so we deploy Plots → Repairs → wire.
///
/// Run:
///   forge script contracts/script/Deploy.s.sol \
///     --rpc-url https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// Env knobs (all optional — sensible defaults match src/chain/config.ts):
///   PLOT_PRICE_WEI    (default 0.01 ether)
///   REPAIR_PRICE_WEI  (default 0.03 ether)
///   TREASURY          (default = deployer)
///   REPAIR_URI        (default "https://chainsweeper.local/repair/{id}.json")
contract Deploy is Script {
    function run() external {
        uint256 plotPrice   = vm.envOr("PLOT_PRICE_WEI",   uint256(0.01 ether));
        uint256 repairPrice = vm.envOr("REPAIR_PRICE_WEI", uint256(0.03 ether));
        string memory repairUri = vm.envOr(
            "REPAIR_URI",
            string("https://chainsweeper.local/repair/{id}.json")
        );

        // Derive deployer + treasury from the broadcast signer. Treasury
        // defaults to the deployer so testing works without extra config;
        // override in prod.
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);

        uint64 nonce = vm.getNonce(deployer);

        // Predict the Match CREATE address. Ratings deploys at `nonce`, Match
        // at `nonce+1`. If these don't match what we actually get, the
        // assertion below catches it before any state is written to chain.
        address predictedMatch = vm.computeCreateAddress(deployer, nonce + 1);

        vm.startBroadcast();

        // 1. Ratings — needs the Match address (immutable). Pass the prediction.
        MachineSweepRatings ratings = new MachineSweepRatings(predictedMatch);

        // 2. Match — needs the Ratings address (immutable).
        MachineSweepMatch matchC = new MachineSweepMatch(address(ratings));
        require(address(matchC) == predictedMatch, "match-addr-mismatch");

        // 3. Plots — standalone; repair wiring happens after Repairs deploys.
        MachineSweepPlots plots = new MachineSweepPlots(plotPrice, treasury);

        // 4. Repairs — needs Plots address.
        MachineSweepRepairs repairs = new MachineSweepRepairs(
            address(plots),
            repairPrice,
            treasury,
            repairUri
        );

        // 5. One-shot setter to close the Plots ↔ Repairs circle.
        plots.setRepairs(address(repairs));

        // 6. Marketplace — needs Plots.
        MachineSweepMarketplace market = new MachineSweepMarketplace(address(plots));

        vm.stopBroadcast();

        // ---- Log everything the frontend + worker need ----------------------
        console2.log("----- MachineSweep deploy complete -----");
        console2.log("deployer      :", deployer);
        console2.log("treasury      :", treasury);
        console2.log("ratings       :", address(ratings));
        console2.log("match         :", address(matchC));
        console2.log("plots         :", address(plots));
        console2.log("repairs       :", address(repairs));
        console2.log("marketplace   :", address(market));
        console2.log("plotPriceWei  :", plotPrice);
        console2.log("repairPriceWei:", repairPrice);
        console2.log("");
        console2.log("Paste into .env:");
        console2.log("VITE_RATINGS_CONTRACT=", address(ratings));
        console2.log("VITE_MATCH_CONTRACT=", address(matchC));
        console2.log("VITE_PLOTS_CONTRACT=", address(plots));
        console2.log("VITE_REPAIRS_CONTRACT=", address(repairs));
        console2.log("VITE_MARKETPLACE_CONTRACT=", address(market));
        console2.log("");
        console2.log("Paste into wrangler.toml [vars]:");
        console2.log("PLOTS_ADDRESS=", address(plots));
        console2.log("MARKETPLACE_ADDRESS=", address(market));
    }
}
