// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title MinimalERC1155
/// @notice Minimal ERC-1155 surface for MachineSweepRepairs. Same motivation
///         as MinimalERC721: OZ 5.6 emits `mcopy`, BITE requires istanbul.
///         We only need single-id balanceOf + safeTransferFrom + approvals.
///         Batch ops are stubbed to revert — we don't use them.
abstract contract MinimalERC1155 {
    mapping(uint256 => mapping(address => uint256)) internal _balances;
    mapping(address => mapping(address => bool)) internal _operatorApprovals;

    string public uri;

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    error InvalidReceiver(address to);
    error InsufficientBalance(address from, uint256 id, uint256 have, uint256 want);
    error NotOwnerOrApproved();
    error BatchUnsupported();

    constructor(string memory _uri) {
        uri = _uri;
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids)
        external
        view
        returns (uint256[] memory out)
    {
        require(accounts.length == ids.length, "length");
        out = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            out[i] = _balances[ids[i]][accounts[i]];
        }
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert NotOwnerOrApproved();
        _transfer(from, to, id, value);
        _checkOnERC1155Received(from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address, address, uint256[] calldata, uint256[] calldata, bytes calldata
    ) external pure {
        revert BatchUnsupported();
    }

    function supportsInterface(bytes4 interfaceId) public pure virtual returns (bool) {
        // ERC-1155 (0xd9b67a26) and ERC-165 (0x01ffc9a7)
        return interfaceId == 0xd9b67a26 || interfaceId == 0x01ffc9a7;
    }

    // ---- Internal ---------------------------------------------------------

    function _mint(address to, uint256 id, uint256 value) internal {
        if (to == address(0)) revert InvalidReceiver(to);
        unchecked { _balances[id][to] += value; }
        emit TransferSingle(msg.sender, address(0), to, id, value);
    }

    function _burn(address from, uint256 id, uint256 value) internal {
        uint256 have = _balances[id][from];
        if (have < value) revert InsufficientBalance(from, id, have, value);
        unchecked { _balances[id][from] = have - value; }
        emit TransferSingle(msg.sender, from, address(0), id, value);
    }

    function _transfer(address from, address to, uint256 id, uint256 value) internal {
        if (to == address(0)) revert InvalidReceiver(to);
        uint256 have = _balances[id][from];
        if (have < value) revert InsufficientBalance(from, id, have, value);
        unchecked {
            _balances[id][from] = have - value;
            _balances[id][to] += value;
        }
        emit TransferSingle(msg.sender, from, to, id, value);
    }

    function _checkOnERC1155Received(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) private {
        if (to.code.length == 0) return;
        // 0xf23a6e61 == IERC1155Receiver.onERC1155Received.selector
        try IERC1155ReceiverMinimal(to).onERC1155Received(msg.sender, from, id, value, data) returns (bytes4 ret) {
            if (ret != 0xf23a6e61) revert InvalidReceiver(to);
        } catch {
            revert InvalidReceiver(to);
        }
    }
}

interface IERC1155ReceiverMinimal {
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external returns (bytes4);
}
