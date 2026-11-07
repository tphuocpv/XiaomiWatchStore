// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Stores only an order digest and state. Customer details stay in MySQL.
contract OrderRegistry {
    address public immutable admin;
    mapping(bytes32 => bytes32) public orderHash;
    mapping(bytes32 => uint8) public orderStatus;

    error InvalidAdmin();
    error OnlyAdmin();
    error InvalidOrderProof();

    event OrderAnchored(
        bytes32 indexed orderKey,
        bytes32 indexed orderDigest,
        uint8 status,
        address indexed recorder
    );

    constructor(address adminAddress) {
        if (adminAddress == address(0)) revert InvalidAdmin();
        admin = adminAddress;
    }

    function anchorOrder(bytes32 key, bytes32 digest, uint8 status) external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (key == bytes32(0) || digest == bytes32(0)) revert InvalidOrderProof();
        orderHash[key] = digest;
        orderStatus[key] = status;
        emit OrderAnchored(key, digest, status, msg.sender);
    }
}
