// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IERC721Minimal {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC721ReceiverMinimal {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external returns (bytes4);
}

/// @title MachineSweepMarketplace — escrow marketplace for Territories plots
/// @notice Escrow model: seller transfers plot NFT into this contract on
///         list; buyer pays native SKALE on buy; contract forwards payment
///         and transfers NFT out. Corrupted plots are listable — buyers can
///         inspect status via the Plots contract before purchasing.
contract MachineSweepMarketplace is IERC721ReceiverMinimal {
    IERC721Minimal public immutable PLOTS;

    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    mapping(uint256 => Listing) public listings;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Bought(uint256 indexed tokenId, address indexed buyer, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event PriceUpdated(uint256 indexed tokenId, uint256 newPrice);

    error NotSeller();
    error NotListed();
    error AlreadyListed();
    error WrongPayment();
    error PayoutFailed();
    error ZeroPrice();

    constructor(address plots) {
        PLOTS = IERC721Minimal(plots);
    }

    /// @notice List a plot for sale. Caller must own or be approved for the
    ///         NFT and must have approved this contract (or used setApprovalForAll).
    function list(uint256 tokenId, uint256 price) external {
        if (price == 0) revert ZeroPrice();
        if (listings[tokenId].active) revert AlreadyListed();

        // transferFrom checks ownership + approval for us.
        PLOTS.transferFrom(msg.sender, address(this), tokenId);

        listings[tokenId] = Listing({ seller: msg.sender, price: price, active: true });
        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Buy a listed plot. Exact payment required.
    function buy(uint256 tokenId) external payable {
        Listing memory l = listings[tokenId];
        if (!l.active) revert NotListed();
        if (msg.value != l.price) revert WrongPayment();

        delete listings[tokenId];

        PLOTS.transferFrom(address(this), msg.sender, tokenId);

        (bool ok, ) = payable(l.seller).call{ value: l.price }("");
        if (!ok) revert PayoutFailed();

        emit Bought(tokenId, msg.sender, l.seller, l.price);
    }

    /// @notice Seller cancels listing, reclaims the NFT.
    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (!l.active) revert NotListed();
        if (l.seller != msg.sender) revert NotSeller();

        delete listings[tokenId];
        PLOTS.transferFrom(address(this), msg.sender, tokenId);
        emit Cancelled(tokenId, msg.sender);
    }

    /// @notice Update price without re-escrowing.
    function updatePrice(uint256 tokenId, uint256 newPrice) external {
        if (newPrice == 0) revert ZeroPrice();
        Listing storage l = listings[tokenId];
        if (!l.active) revert NotListed();
        if (l.seller != msg.sender) revert NotSeller();
        l.price = newPrice;
        emit PriceUpdated(tokenId, newPrice);
    }

    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return listings[tokenId];
    }

    /// @inheritdoc IERC721ReceiverMinimal
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721ReceiverMinimal.onERC721Received.selector;
    }
}
