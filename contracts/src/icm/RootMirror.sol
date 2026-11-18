// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeleporterReceiver} from "./ITeleporter.sol";
import {IRootSource} from "../PointsGate.sol";

/// @title RootMirror: the zkDB root on another Avalanche L1, written only by ICM messages from RootRelay.
/// @notice A PointsGate deployed next to it checks claims against this root exactly as it does against ZkDB.
contract RootMirror is ITeleporterReceiver, IRootSource {
    address public immutable teleporter;
    bytes32 public immutable sourceBlockchainID;
    /// RootRelay on the source chain.
    address public immutable relay;

    bytes32 public root;
    uint64 public batchNo;

    event RootMirrored(uint64 indexed batchNo, bytes32 root);

    error NotTeleporter();
    error WrongSource();

    constructor(address teleporter_, bytes32 sourceBlockchainID_, address relay_) {
        teleporter = teleporter_;
        sourceBlockchainID = sourceBlockchainID_;
        relay = relay_;
    }

    function receiveTeleporterMessage(bytes32 sourceBlockchainID_, address originSenderAddress, bytes calldata message) external {
        if (msg.sender != teleporter) revert NotTeleporter();
        if (sourceBlockchainID_ != sourceBlockchainID || originSenderAddress != relay) revert WrongSource();
        (uint64 n, bytes32 r) = abi.decode(message, (uint64, bytes32));
        // Messages can arrive out of order; an older root never replaces a newer one.
        if (n <= batchNo) return;
        batchNo = n;
        root = r;
        emit RootMirrored(n, r);
    }
}
