// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeleporterReceiver} from "./ITeleporter.sol";

/// @title ClaimRegistry: on the C-Chain, the perk claims that were proven on the school L1, received over ICM.
/// @notice Written only by TeleporterMessenger, only for messages from ClaimForwarder on the zkdb L1. Each nullifier
/// is recorded once per perk; a second receipt with the same nullifier reverts. A C-Chain app (a sponsor's shop, a
/// ticket desk) reads it to honour a perk without seeing the club's data, and redeem() hands the perk out once,
/// against the one-time code behind the pickup hash, the same way PointsGate.collect() does on the L1.
contract ClaimRegistry is ITeleporterReceiver {
    struct Receipt {
        bytes32 pickup;
        bytes32 root;
        uint64 minPoints;
        uint64 batchNo;
        uint64 receivedAt;
    }

    uint8 public constant PICKUP_NONE = 0;
    uint8 public constant PICKUP_CLAIMED = 1;
    uint8 public constant PICKUP_REDEEMED = 2;

    address public immutable teleporter;
    bytes32 public immutable sourceBlockchainID;
    /// ClaimForwarder on the source L1.
    address public immutable forwarder;

    uint256 public count;
    /// perk id => nullifier => receipt (receivedAt == 0: none).
    mapping(uint256 => mapping(bytes32 => Receipt)) internal receipts;
    /// perk id => pickup hash => PICKUP_NONE, PICKUP_CLAIMED or PICKUP_REDEEMED.
    mapping(uint256 => mapping(bytes32 => uint8)) public pickupState;

    event ClaimRecorded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 indexed pickup, uint64 minPoints, bytes32 root, uint64 batchNo);
    event PerkRedeemed(uint256 indexed perkId, bytes32 indexed pickup);

    error NotTeleporter();
    error WrongSource();
    error AlreadyRecorded();
    error PickupTaken();
    error NothingToRedeem();

    constructor(address teleporter_, bytes32 sourceBlockchainID_, address forwarder_) {
        teleporter = teleporter_;
        sourceBlockchainID = sourceBlockchainID_;
        forwarder = forwarder_;
    }

    function receiveTeleporterMessage(bytes32 sourceBlockchainID_, address originSenderAddress, bytes calldata message) external {
        if (msg.sender != teleporter) revert NotTeleporter();
        if (sourceBlockchainID_ != sourceBlockchainID || originSenderAddress != forwarder) revert WrongSource();
        (uint256 perkId, bytes32 nullifier, bytes32 pickup, uint64 minPoints, bytes32 root, uint64 batchNo) =
            abi.decode(message, (uint256, bytes32, bytes32, uint64, bytes32, uint64));
        if (receipts[perkId][nullifier].receivedAt != 0) revert AlreadyRecorded();
        if (pickupState[perkId][pickup] != PICKUP_NONE) revert PickupTaken();
        receipts[perkId][nullifier] = Receipt(pickup, root, minPoints, batchNo, uint64(block.timestamp));
        pickupState[perkId][pickup] = PICKUP_CLAIMED;
        count++;
        emit ClaimRecorded(perkId, nullifier, pickup, minPoints, root, batchNo);
    }

    function recorded(uint256 perkId, bytes32 nullifier) external view returns (bool) {
        return receipts[perkId][nullifier].receivedAt != 0;
    }

    function receipt(uint256 perkId, bytes32 nullifier) external view returns (Receipt memory) {
        return receipts[perkId][nullifier];
    }

    /// Same hash as PointsGate.pickupHash: SHA-256 of the code, cut to 248 bits.
    function pickupHash(bytes32 code) public pure returns (bytes32) {
        return bytes32(uint256(sha256(abi.encodePacked(code))) >> 8);
    }

    /// Whoever shows the code behind a recorded pickup hash gets the perk, once.
    function redeem(uint256 perkId, bytes32 code) external {
        bytes32 pickup = pickupHash(code);
        if (pickupState[perkId][pickup] != PICKUP_CLAIMED) revert NothingToRedeem();
        pickupState[perkId][pickup] = PICKUP_REDEEMED;
        emit PerkRedeemed(perkId, pickup);
    }
}
