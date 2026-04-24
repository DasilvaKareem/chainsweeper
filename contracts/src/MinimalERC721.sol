// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title MinimalERC721
/// @notice Stripped-down ERC-721 implementation sized for MachineSweep's
///         needs. We inline it because the BITE V2 EVM target is `istanbul`,
///         but the vendored OpenZeppelin 5.6.x emits Cancun-only `mcopy`.
///         This file implements only the interface surface Plots + Marketplace
///         actually touch: ownerOf, balanceOf, transferFrom, safeTransferFrom,
///         approve, setApprovalForAll, plus the ERC-165 + metadata hooks a
///         marketplace needs.
// Swap to OpenZeppelin's ERC721 if/when SKALE confirms Cancun support on the
// target chain (SKALE Base Sepolia today is still Istanbul).
abstract contract MinimalERC721 {
    string public name;
    string public symbol;

    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _tokenApprovals;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotOwnerOrApproved();
    error InvalidReceiver(address to);
    error InvalidOwner(address owner);
    error NonexistentToken(uint256 tokenId);
    error AlreadyMinted(uint256 tokenId);
    error WrongFrom(address from);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function balanceOf(address owner) public view returns (uint256) {
        if (owner == address(0)) revert InvalidOwner(address(0));
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
        return owner;
    }

    function approve(address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) {
            revert NotOwnerOrApproved();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        ownerOf(tokenId); // reverts if nonexistent
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (!_isAuthorized(from, msg.sender, tokenId)) revert NotOwnerOrApproved();
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    /// @notice ERC-165. Supports ERC-721 (0x80ac58cd) and ERC-165 (0x01ffc9a7).
    function supportsInterface(bytes4 interfaceId) public pure virtual returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }

    // ---- Internal ---------------------------------------------------------

    function _ownerOf(uint256 tokenId) internal view returns (address) {
        return _owners[tokenId];
    }

    function _isAuthorized(address owner, address spender, uint256 tokenId) internal view returns (bool) {
        if (owner == address(0)) return false;
        return
            spender == owner ||
            _operatorApprovals[owner][spender] ||
            _tokenApprovals[tokenId] == spender;
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (to == address(0)) revert InvalidReceiver(to);
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken(tokenId);
        if (owner != from) revert WrongFrom(from);

        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _safeMint(address to, uint256 tokenId) internal {
        _mint(to, tokenId);
        _checkOnERC721Received(address(0), to, tokenId, "");
    }

    function _mint(address to, uint256 tokenId) internal {
        if (to == address(0)) revert InvalidReceiver(to);
        if (_owners[tokenId] != address(0)) revert AlreadyMinted(tokenId);
        unchecked { _balances[to] += 1; }
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function _checkOnERC721Received(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) private {
        if (to.code.length == 0) return;
        // 0x150b7a02 == IERC721Receiver.onERC721Received.selector
        try IERC721ReceiverMinimal(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
            if (ret != 0x150b7a02) revert InvalidReceiver(to);
        } catch {
            revert InvalidReceiver(to);
        }
    }
}

interface IERC721ReceiverMinimal {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
