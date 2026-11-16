// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Holds local test ETH for an order until delivery, or returns it when cancelled before shipping.
/// Customer identity and shipping details remain in MySQL.
contract OrderEscrow {
    enum Status { None, Escrowed, Shipped, Released, Refunded, Cancelled }

    struct Payment {
        address payable buyer;
        uint256 amount;
        bytes32 invoiceHash;
        Status status;
    }

    address public immutable admin;
    address payable public immutable merchant;
    address public immutable quoteSigner;
    mapping(bytes32 => Payment) public payments;

    error InvalidAdmin();
    error InvalidMerchant();
    error OnlyAdmin();
    error InvalidOrder();
    error InvalidAmount();
    error InvalidQuote();
    error ExpiredQuote();
    error InvalidState();
    error TransferFailed();

    event PaymentEscrowed(bytes32 indexed orderKey, address indexed buyer, uint256 amount, bytes32 invoiceHash);
    event OrderMarkedShipped(bytes32 indexed orderKey);
    event OrderReleased(bytes32 indexed orderKey, address indexed merchant, uint256 amount);
    event OrderRefunded(bytes32 indexed orderKey, address indexed buyer, uint256 amount);
    event OrderCancelled(bytes32 indexed orderKey);

    constructor(address adminAddress, address quoteSignerAddress, address payable merchantAddress) {
        if (adminAddress == address(0) || quoteSignerAddress == address(0)) revert InvalidAdmin();
        if (merchantAddress == address(0)) revert InvalidMerchant();
        admin = adminAddress;
        merchant = merchantAddress;
        quoteSigner = quoteSignerAddress;
    }

    function payOrder(bytes32 orderKey, bytes32 invoiceHash, uint256 expectedAmount, uint256 deadline, bytes calldata signature) external payable {
        if (orderKey == bytes32(0) || invoiceHash == bytes32(0)) revert InvalidOrder();
        if (payments[orderKey].status != Status.None) revert InvalidState();
        if (expectedAmount == 0 || msg.value != expectedAmount) revert InvalidAmount();
        if (block.timestamp > deadline) revert ExpiredQuote();
        bytes32 quoteHash = keccak256(abi.encode(orderKey, invoiceHash, expectedAmount, deadline, block.chainid, address(this)));
        bytes32 signedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", quoteHash));
        if (_recover(signedHash, signature) != quoteSigner) revert InvalidQuote();
        payments[orderKey] = Payment(payable(msg.sender), msg.value, invoiceHash, Status.Escrowed);
        emit PaymentEscrowed(orderKey, msg.sender, msg.value, invoiceHash);
    }

    function markShipped(bytes32 orderKey) external onlyAdmin {
        Payment storage payment = payments[orderKey];
        if (payment.status != Status.Escrowed) revert InvalidState();
        payment.status = Status.Shipped;
        emit OrderMarkedShipped(orderKey);
    }

    function releaseOrder(bytes32 orderKey) external onlyAdmin {
        Payment storage payment = payments[orderKey];
        if (payment.status != Status.Shipped) revert InvalidState();
        uint256 amount = payment.amount;
        payment.status = Status.Released;
        (bool sent,) = merchant.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit OrderReleased(orderKey, merchant, amount);
    }

    function refundOrder(bytes32 orderKey) external onlyAdmin {
        Payment storage payment = payments[orderKey];
        if (payment.status != Status.Escrowed) revert InvalidState();
        address payable buyer = payment.buyer;
        uint256 amount = payment.amount;
        payment.status = Status.Refunded;
        (bool sent,) = buyer.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit OrderRefunded(orderKey, buyer, amount);
    }

    function cancelUnpaidOrder(bytes32 orderKey) external onlyAdmin {
        if (orderKey == bytes32(0) || payments[orderKey].status != Status.None) revert InvalidState();
        payments[orderKey].status = Status.Cancelled;
        emit OrderCancelled(orderKey);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidQuote();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidQuote();
        signer = ecrecover(digest, v, r, s);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }
}
