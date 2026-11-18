// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IHonkVerifier} from "./IHonkVerifier.sol";

/// Anything that holds a proven zkDB root: ZkDB itself, or a mirror on another chain fed over ICM.
interface IRootSource {
    function root() external view returns (bytes32);
}

/// @title PointsGate: perks unlocked by a zero-knowledge proof about the proven zkDB root.
/// @notice A member proves "a card in the current root has at least minPoints, I hold its secret, and this is its
/// nullifier for this perk". The proof does not say which card. The gate keeps no balances and takes no input from
/// the club: the only state it believes is the root that ZkDB accepted with a batch proof.
///
/// A claim is made out to a pickup hash: the hash of a one-time code the member's device makes up. The hash is a
/// public input of the proof, so a copied proof can only record the claim for the same pickup hash. At the desk the
/// member shows the code; collect() checks it and marks the perk handed out, once.
contract PointsGate {
    struct Perk {
        uint256 tableId;
        uint64 minPoints;
        uint64 claims;
        string name;
    }

    IRootSource public immutable db;
    IHonkVerifier public immutable claimVerifier;
    address public immutable admin;

    uint8 public constant PICKUP_NONE = 0;
    uint8 public constant PICKUP_CLAIMED = 1;
    uint8 public constant PICKUP_COLLECTED = 2;

    Perk[] internal perks;
    /// perk id => nullifier => claimed. A nullifier is Poseidon2(card secret, perk id): one per card and perk.
    mapping(uint256 => mapping(bytes32 => bool)) public claimed;
    /// perk id => pickup hash => PICKUP_NONE, PICKUP_CLAIMED or PICKUP_COLLECTED.
    mapping(uint256 => mapping(bytes32 => uint8)) public pickupState;

    event PerkAdded(uint256 indexed perkId, uint256 indexed tableId, uint64 minPoints, string name);
    event PerkClaimed(uint256 indexed perkId, bytes32 indexed nullifier, bytes32 indexed pickup, bytes32 root);
    event PerkCollected(uint256 indexed perkId, bytes32 indexed pickup);

    error NotAdmin();
    error UnknownPerk();
    error AlreadyClaimed();
    error PickupTaken();
    error NothingToCollect();
    error InvalidProof();

    constructor(IRootSource db_, IHonkVerifier claimVerifier_) {
        db = db_;
        claimVerifier = claimVerifier_;
        admin = msg.sender;
    }

    function addPerk(uint256 tableId, uint64 minPoints, string calldata name) external returns (uint256 perkId) {
        if (msg.sender != admin) revert NotAdmin();
        perkId = perks.length;
        perks.push(Perk(tableId, minPoints, 0, name));
        emit PerkAdded(perkId, tableId, minPoints, name);
    }

    function perkCount() external view returns (uint256) {
        return perks.length;
    }

    function perk(uint256 perkId) external view returns (Perk memory) {
        if (perkId >= perks.length) revert UnknownPerk();
        return perks[perkId];
    }

    /// The pickup hash of a one-time code: SHA-256, cut to 248 bits so it fits a field element of the proof system.
    function pickupHash(bytes32 code) public pure returns (bytes32) {
        return bytes32(uint256(sha256(abi.encodePacked(code))) >> 8);
    }

    /// Anyone may send this: the proof is the permission, so a member needs no wallet and a relayer can pay the gas.
    /// The proof is checked against the root ZkDB holds right now. If a batch lands first, prove again.
    /// @param pickup who the claim is for: pickupHash(code) of a code only the member knows. Sending someone else's
    /// proof first changes nothing for them, because the proof does not verify with any other pickup hash.
    function claim(bytes calldata proof, uint256 perkId, bytes32 nullifier, bytes32 pickup) external {
        if (perkId >= perks.length) revert UnknownPerk();
        if (claimed[perkId][nullifier]) revert AlreadyClaimed();
        if (pickupState[perkId][pickup] != PICKUP_NONE) revert PickupTaken();
        Perk storage p = perks[perkId];
        bytes32 root = db.root();

        bytes32[] memory pi = new bytes32[](6);
        pi[0] = root;
        pi[1] = bytes32(p.tableId);
        pi[2] = bytes32(uint256(p.minPoints));
        pi[3] = bytes32(perkId);
        pi[4] = nullifier;
        pi[5] = pickup;
        if (!claimVerifier.verify(proof, pi)) revert InvalidProof();

        claimed[perkId][nullifier] = true;
        pickupState[perkId][pickup] = PICKUP_CLAIMED;
        p.claims++;
        emit PerkClaimed(perkId, nullifier, pickup, root);
    }

    /// The desk hands the perk out: whoever shows the code behind a claimed pickup hash collects it, once.
    function collect(uint256 perkId, bytes32 code) external {
        bytes32 pickup = pickupHash(code);
        if (pickupState[perkId][pickup] != PICKUP_CLAIMED) revert NothingToCollect();
        pickupState[perkId][pickup] = PICKUP_COLLECTED;
        emit PerkCollected(perkId, pickup);
    }
}
