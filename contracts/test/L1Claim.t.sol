// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZkDB} from "../src/ZkDB.sol";
import {PointsGate, IRootSource} from "../src/PointsGate.sol";
import {IHonkVerifier} from "../src/IHonkVerifier.sol";
import {BatchVerifier} from "../src/verifiers/BatchVerifier.sol";
import {ClaimVerifier} from "../src/verifiers/ClaimVerifier.sol";
import {RootRelay, IProvenRoot} from "../src/icm/RootRelay.sol";
import {RootMirror} from "../src/icm/RootMirror.sol";
import {ClaimForwarder} from "../src/icm/ClaimForwarder.sol";
import {ClaimRegistry} from "../src/icm/ClaimRegistry.sol";
import {MockTeleporter} from "./RootRelay.t.sol";

/// Both directions between the C-Chain and the school L1, with one mock messenger per chain:
/// ZkDB root on the C-Chain → RootRelay → RootMirror on the L1; a claim proven against the mirrored root on the L1 →
/// ClaimForwarder → ClaimRegistry on the C-Chain. Real proofs from test/fixtures/claim_1.json.
contract L1ClaimTest is Test {
    bytes32 constant FUJI = 0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5;
    bytes32 constant ZKDB_L1 = 0x91640ec25733e7e73efdbe0f31050d5c9d5f7f8749b7a7c35b6d7b9900694dd4;

    // C-Chain side
    ZkDB db;
    MockTeleporter fujiMessenger; // delivers C-Chain messages on the L1
    RootRelay relay;
    ClaimRegistry registry;
    // L1 side
    MockTeleporter l1Messenger; // delivers L1 messages on the C-Chain
    RootMirror mirror;
    PointsGate gate;
    ClaimForwarder forwarder;

    string json;
    address treasurer = address(0xBEEF);

    function setUp() public {
        json = vm.readFile("test/fixtures/claim_1.json");
        db = new ZkDB(IHonkVerifier(address(new BatchVerifier())), vm.parseJsonBytes32(json, ".emptyRoot"));
        db.setWriter(treasurer, true);
        db.setTableOwner(1, treasurer);
        fujiMessenger = new MockTeleporter(FUJI);
        l1Messenger = new MockTeleporter(ZKDB_L1);

        // Each side names the other's contract before it exists, as the real deployment does (addresses from nonces).
        uint256 n = vm.getNonce(address(this));
        address mirrorAt = vm.computeCreateAddress(address(this), n + 2);
        address forwarderAt = vm.computeCreateAddress(address(this), n + 5);
        relay = new RootRelay(IProvenRoot(address(db)), fujiMessenger, ZKDB_L1, mirrorAt); // n
        registry = new ClaimRegistry(address(l1Messenger), ZKDB_L1, forwarderAt); // n + 1
        mirror = new RootMirror(address(fujiMessenger), FUJI, address(relay)); // n + 2
        ClaimVerifier verifier = new ClaimVerifier(); // n + 3
        gate = new PointsGate(IRootSource(address(mirror)), IHonkVerifier(address(verifier))); // n + 4
        forwarder = new ClaimForwarder(gate, l1Messenger, FUJI, address(registry)); // n + 5
        assertEq(address(mirror), mirrorAt);
        assertEq(address(forwarder), forwarderAt);
        gate.addPerk(1, 500, "Priority event ticket");
    }

    function _proveBatch() internal {
        uint256[] memory flat = vm.parseJsonUintArray(json, ".opsFlat");
        uint256[9][] memory ops = new uint256[9][](flat.length / 9);
        vm.startPrank(treasurer);
        for (uint256 i = 0; i < ops.length; i++) {
            uint256[6] memory v;
            for (uint256 j = 0; j < 9; j++) ops[i][j] = flat[i * 9 + j];
            for (uint256 j = 0; j < 6; j++) v[j] = ops[i][3 + j];
            db.insert(ops[i][2], v);
        }
        vm.stopPrank();
        bool[16] memory ok;
        for (uint256 i = 0; i < 16; i++) ok[i] = true;
        db.submitBatch(vm.parseJsonBytes(json, ".batchProof"), vm.parseJsonBytes32(json, ".root"), ok, ops);
    }

    function _claim(uint256 i) internal view returns (bytes memory proof, bytes32 nullifier, bytes32 pickup, bytes32 code) {
        string memory c = string.concat(".claims[", vm.toString(i), "]");
        proof = vm.parseJsonBytes(json, string.concat(c, ".proof"));
        nullifier = vm.parseJsonBytes32(json, string.concat(c, ".nullifier"));
        pickup = vm.parseJsonBytes32(json, string.concat(c, ".pickup"));
        code = vm.parseJsonBytes32(json, string.concat(c, ".pickupCode"));
    }

    function _mirrorRoot() internal {
        _proveBatch();
        relay.relay();
        fujiMessenger.deliver();
    }

    function test_roundTrip_rootToTheL1_claimReceiptBackToTheCChain() public {
        _mirrorRoot();
        assertEq(mirror.root(), db.root());
        assertEq(mirror.batchNo(), 1);

        (bytes memory proof, bytes32 nullifier, bytes32 pickup, bytes32 code) = _claim(0);
        vm.prank(address(0x1234)); // anyone: the proof is the permission
        forwarder.claimAndForward(proof, 0, nullifier, pickup);
        assertTrue(gate.claimed(0, nullifier));

        (bytes32 dest, address to,, uint256 gasLimit, bytes memory message) = l1Messenger.last();
        assertEq(dest, FUJI);
        assertEq(to, address(registry));
        assertEq(gasLimit, 300_000);
        assertEq(message, abi.encode(uint256(0), nullifier, pickup, uint64(500), db.root(), uint64(1)));
        assertEq(l1Messenger.lastSender(), address(forwarder));

        assertFalse(registry.recorded(0, nullifier));
        l1Messenger.deliver();
        assertTrue(registry.recorded(0, nullifier));
        assertEq(registry.count(), 1);
        ClaimRegistry.Receipt memory r = registry.receipt(0, nullifier);
        assertEq(r.pickup, pickup);
        assertEq(r.root, db.root());
        assertEq(r.minPoints, 500);
        assertEq(r.batchNo, 1);

        // A sponsor on the C-Chain hands the perk out once, against the one-time code.
        assertEq(registry.pickupHash(code), pickup);
        registry.redeem(0, code);
        assertEq(registry.pickupState(0, pickup), registry.PICKUP_REDEEMED());
        vm.expectRevert(ClaimRegistry.NothingToRedeem.selector);
        registry.redeem(0, code);
    }

    function test_twoCards_twoReceipts() public {
        _mirrorRoot();
        for (uint256 i = 0; i < 2; i++) {
            (bytes memory proof, bytes32 nullifier, bytes32 pickup,) = _claim(i);
            forwarder.claimAndForward(proof, 0, nullifier, pickup);
            l1Messenger.deliver();
            assertTrue(registry.recorded(0, nullifier));
        }
        assertEq(registry.count(), 2);
    }

    function test_nullifier_isRecordedOnce() public {
        _mirrorRoot();
        (bytes memory proof, bytes32 nullifier, bytes32 pickup,) = _claim(0);
        forwarder.claimAndForward(proof, 0, nullifier, pickup);
        l1Messenger.deliver();

        // On the L1 the gate refuses the same nullifier, so no second receipt is sent.
        vm.expectRevert(PointsGate.AlreadyClaimed.selector);
        forwarder.claimAndForward(proof, 0, nullifier, pickup);
        assertEq(l1Messenger.sent(), 1);

        // On the C-Chain the registry refuses it too, even with another pickup hash.
        bytes memory again = abi.encode(uint256(0), nullifier, bytes32(uint256(7)), uint64(500), db.root(), uint64(1));
        vm.expectRevert(ClaimRegistry.AlreadyRecorded.selector);
        l1Messenger.deliverAs(ZKDB_L1, address(forwarder), address(registry), again);
        assertEq(registry.count(), 1);
    }

    function test_registry_acceptsOnlyTheForwarderOverTeleporter() public {
        bytes memory forged = abi.encode(uint256(0), bytes32(uint256(1)), bytes32(uint256(2)), uint64(500), bytes32(uint256(3)), uint64(1));
        vm.expectRevert(ClaimRegistry.NotTeleporter.selector);
        registry.receiveTeleporterMessage(ZKDB_L1, address(forwarder), forged);
        vm.expectRevert(ClaimRegistry.WrongSource.selector);
        l1Messenger.deliverAs(ZKDB_L1, address(0xBAD), address(registry), forged);
        vm.expectRevert(ClaimRegistry.WrongSource.selector);
        l1Messenger.deliverAs(FUJI, address(forwarder), address(registry), forged);
        assertEq(registry.count(), 0);
    }

    function test_forwarder_sendsNothingForABadOrEarlyClaim() public {
        (bytes memory proof, bytes32 nullifier, bytes32 pickup,) = _claim(0);
        vm.expectRevert(); // nothing mirrored yet: the proof does not match the empty root
        forwarder.claimAndForward(proof, 0, nullifier, pickup);

        _mirrorRoot();
        proof[100] = bytes1(uint8(proof[100]) ^ 1);
        vm.expectRevert();
        forwarder.claimAndForward(proof, 0, nullifier, pickup);
        // A valid proof made out to one pickup hash does not verify for another.
        (proof,,,) = _claim(0);
        vm.expectRevert(); // the verifier rejects it (its own error, or InvalidProof)
        forwarder.claimAndForward(proof, 0, nullifier, bytes32(uint256(pickup) ^ 1));
        assertEq(l1Messenger.sent(), 0);
    }

    function test_registry_receiveFitsTheGasLimit() public {
        _mirrorRoot();
        (bytes memory proof, bytes32 nullifier, bytes32 pickup,) = _claim(0);
        uint256 g = gasleft();
        forwarder.claimAndForward(proof, 0, nullifier, pickup);
        emit log_named_uint("claimAndForward gas on the L1", g - gasleft());
        g = gasleft();
        l1Messenger.deliver();
        uint256 used = g - gasleft();
        emit log_named_uint("ClaimRegistry receive gas (limit 300,000)", used);
        assertLt(used, 300_000);
    }
}
