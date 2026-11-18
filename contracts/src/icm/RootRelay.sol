// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeleporterMessenger, TeleporterMessageInput, TeleporterFeeInfo} from "./ITeleporter.sol";

interface IProvenRoot {
    function root() external view returns (bytes32);
    function batchCount() external view returns (uint64);
}

/// @title RootRelay: sends the proven zkDB root to another Avalanche L1 over ICM (Teleporter).
/// @notice One 32-byte root stands for every balance. The other chain does not re-run the ops and does not need
/// the club's data: a member opens their own row against the relayed root. Anyone may call relay(); it reads the
/// root from ZkDB itself, so the caller cannot choose what is sent.
contract RootRelay {
    uint256 public constant RECEIVE_GAS = 200_000;

    IProvenRoot public immutable db;
    ITeleporterMessenger public immutable teleporter;
    bytes32 public immutable destinationBlockchainID;
    /// RootMirror on the destination chain.
    address public immutable mirror;

    uint64 public lastRelayedBatch;

    event RootRelayed(uint64 indexed batchNo, bytes32 root, bytes32 indexed messageID);

    error NothingNew();

    constructor(IProvenRoot db_, ITeleporterMessenger teleporter_, bytes32 destinationBlockchainID_, address mirror_) {
        db = db_;
        teleporter = teleporter_;
        destinationBlockchainID = destinationBlockchainID_;
        mirror = mirror_;
    }

    function relay() external returns (bytes32 messageID) {
        uint64 batchNo = db.batchCount();
        if (batchNo <= lastRelayedBatch) revert NothingNew();
        bytes32 root = db.root();
        lastRelayedBatch = batchNo;
        messageID = teleporter.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: destinationBlockchainID,
                destinationAddress: mirror,
                // No relayer fee: on Fuji the public ICM relayer delivers between the C-Chain, Dispatch and Echo.
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: RECEIVE_GAS,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(batchNo, root)
            })
        );
        emit RootRelayed(batchNo, root, messageID);
    }
}
