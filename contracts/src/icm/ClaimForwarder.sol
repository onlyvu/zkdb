// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeleporterMessenger, TeleporterMessageInput, TeleporterFeeInfo} from "./ITeleporter.sol";
import {PointsGate} from "../PointsGate.sol";
import {RootMirror} from "./RootMirror.sol";

/// @title ClaimForwarder: on the school L1, checks a zero-knowledge perk claim and sends a receipt over ICM.
/// @notice The claim is checked by a PointsGate that reads the root RootMirror received from the C-Chain. If the gate
/// accepts it (valid proof, nullifier not used on this gate), a receipt goes to ClaimRegistry on the C-Chain: perk id,
/// nullifier, pickup hash, the perk's threshold and the root the proof was checked against. The receipt carries no
/// card number and no balance. Anyone may call: the proof is the permission, so a member needs no wallet.
/// A claim sent straight to the gate is valid on the L1 but stays there; only claims made through here are forwarded.
contract ClaimForwarder {
    uint256 public constant RECEIVE_GAS = 300_000;

    PointsGate public immutable gate;
    RootMirror public immutable mirror;
    ITeleporterMessenger public immutable teleporter;
    bytes32 public immutable destinationBlockchainID;
    /// ClaimRegistry on the destination chain.
    address public immutable registry;

    event ClaimForwarded(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 pickup, bytes32 root, uint64 batchNo, bytes32 indexed messageID);

    constructor(PointsGate gate_, ITeleporterMessenger teleporter_, bytes32 destinationBlockchainID_, address registry_) {
        gate = gate_;
        mirror = RootMirror(address(gate_.db()));
        teleporter = teleporter_;
        destinationBlockchainID = destinationBlockchainID_;
        registry = registry_;
    }

    function claimAndForward(bytes calldata proof, uint256 perkId, bytes32 nullifier, bytes32 pickup) external returns (bytes32 messageID) {
        // Reverts on a bad proof, an unknown perk, a used nullifier or a taken pickup hash.
        gate.claim(proof, perkId, nullifier, pickup);
        bytes32 root = mirror.root();
        uint64 batchNo = mirror.batchNo();
        uint64 minPoints = gate.perk(perkId).minPoints;
        messageID = teleporter.sendCrossChainMessage(
            TeleporterMessageInput({
                destinationBlockchainID: destinationBlockchainID,
                destinationAddress: registry,
                // No relayer fee: the team's ICM relayer delivers between the C-Chain and the zkdb L1.
                feeInfo: TeleporterFeeInfo({feeTokenAddress: address(0), amount: 0}),
                requiredGasLimit: RECEIVE_GAS,
                allowedRelayerAddresses: new address[](0),
                message: abi.encode(perkId, nullifier, pickup, minPoints, root, batchNo)
            })
        );
        emit ClaimForwarded(perkId, nullifier, pickup, root, batchNo, messageID);
    }
}
