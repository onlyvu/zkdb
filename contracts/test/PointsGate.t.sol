// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZkDB} from "../src/ZkDB.sol";
import {PointsGate, IRootSource} from "../src/PointsGate.sol";
import {IHonkVerifier} from "../src/IHonkVerifier.sol";
import {BatchVerifier} from "../src/verifiers/BatchVerifier.sol";
import {ClaimVerifier} from "../src/verifiers/ClaimVerifier.sol";

/// Real proofs from packages/zkdb/scripts/gen-claim-fixture.ts: cards #0042 (1,250 points) and #0107 (550) join
/// table 1 in one proven batch, then each proves "at least 500 points" without naming itself.
contract PointsGateTest is Test {
    ZkDB db;
    PointsGate gate;
    string json;
    address treasurer = address(0xBEEF);

    function setUp() public {
        json = vm.readFile("test/fixtures/claim_1.json");
        db = new ZkDB(IHonkVerifier(address(new BatchVerifier())), vm.parseJsonBytes32(json, ".emptyRoot"));
        db.setWriter(treasurer, true);
        db.setTableOwner(1, treasurer);
        gate = new PointsGate(IRootSource(address(db)), IHonkVerifier(address(new ClaimVerifier())));
        gate.addPerk(1, 500, "Priority event ticket");
    }

    function _join() internal {
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

    function _proof(uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, string.concat(".claims[", vm.toString(i), "].proof"));
    }

    function _nullifier(uint256 i) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, string.concat(".claims[", vm.toString(i), "].nullifier"));
    }

    function _pickup(uint256 i) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, string.concat(".claims[", vm.toString(i), "].pickup"));
    }

    function _code(uint256 i) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, string.concat(".claims[", vm.toString(i), "].pickupCode"));
    }

    function test_claim_acceptedAgainstTheProvenRoot() public {
        _join();
        vm.expectEmit(true, true, false, true);
        emit PointsGate.PerkClaimed(0, _nullifier(0), _pickup(0), db.root());
        // any account can relay it: the proof is the permission
        vm.prank(address(0x1234));
        gate.claim(_proof(0), 0, _nullifier(0), _pickup(0));
        assertTrue(gate.claimed(0, _nullifier(0)));
        assertEq(gate.perk(0).claims, 1);
    }

    function test_claim_eachCardOncePerPerk() public {
        _join();
        gate.claim(_proof(0), 0, _nullifier(0), _pickup(0));
        vm.expectRevert(PointsGate.AlreadyClaimed.selector);
        gate.claim(_proof(0), 0, _nullifier(0), _pickup(0));

        gate.claim(_proof(1), 0, _nullifier(1), _pickup(1));
        assertEq(gate.perk(0).claims, 2);
    }

    /// Before the batch proof lands, the members exist only in the queue. The gate does not believe the queue.
    function test_claim_rejectedUntilTheBatchIsProven() public {
        bytes memory proof = _proof(0);
        bytes32 n = _nullifier(0);
        vm.expectRevert();
        gate.claim(proof, 0, n, _pickup(0));
        _join();
        gate.claim(proof, 0, n, _pickup(0));
    }

    function test_claim_rejectsAnotherNullifier() public {
        _join();
        bytes memory proof = _proof(0);
        vm.expectRevert();
        gate.claim(proof, 0, bytes32(uint256(1)), _pickup(0));
    }

    /// The threshold is a public input taken from the perk, so a proof for 500 points does not open a 1,000 perk.
    function test_claim_proofIsBoundToThePerk() public {
        _join();
        gate.addPerk(1, 1000, "Volunteer certificate");
        bytes memory proof = _proof(0);
        bytes32 n = _nullifier(0);
        vm.expectRevert();
        gate.claim(proof, 1, n, _pickup(0));
    }

    /// A later batch changes the root; an old proof no longer matches and has to be made again.
    function test_claim_rejectsAStaleRoot() public {
        _join();
        vm.mockCall(address(db), abi.encodeWithSelector(IRootSource.root.selector), abi.encode(bytes32(uint256(7))));
        bytes memory proof = _proof(0);
        bytes32 n = _nullifier(0);
        vm.expectRevert();
        gate.claim(proof, 0, n, _pickup(0));
    }

    /// Round-2 audit PoC: the proof used to name nobody, so a copy sent first took the claim. Now the pickup hash is a
    /// public input. A front-runner can only (a) fail with their own pickup hash, or (b) record the claim for the
    /// member's pickup hash, which only the member's code collects.
    function test_claim_copiedProofCannotBeRedirected() public {
        _join();
        bytes memory proof = _proof(0);
        bytes32 n = _nullifier(0);
        bytes32 members = _pickup(0);
        bytes32 thiefCode = bytes32(uint256(0xBAD));
        bytes32 thiefs = gate.pickupHash(thiefCode);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        gate.claim(proof, 0, n, thiefs); // the proof does not verify for another pickup hash
        assertFalse(gate.claimed(0, n));

        vm.prank(address(0xBAD));
        gate.claim(proof, 0, n, members); // sent first, unchanged: recorded for the member
        assertEq(gate.pickupState(0, members), gate.PICKUP_CLAIMED());

        vm.prank(address(0xBAD));
        vm.expectRevert(PointsGate.NothingToCollect.selector);
        gate.collect(0, thiefCode);

        gate.collect(0, _code(0)); // the member shows the code at the desk
        assertEq(gate.pickupState(0, members), gate.PICKUP_COLLECTED());
    }

    function test_collect_onlyOnce_onlyForAClaim() public {
        _join();
        vm.expectRevert(PointsGate.NothingToCollect.selector);
        gate.collect(0, _code(0)); // nothing claimed yet
        gate.claim(_proof(0), 0, _nullifier(0), _pickup(0));

        vm.expectEmit(true, true, false, false);
        emit PointsGate.PerkCollected(0, _pickup(0));
        gate.collect(0, _code(0));
        vm.expectRevert(PointsGate.NothingToCollect.selector);
        gate.collect(0, _code(0));
        vm.expectRevert(PointsGate.NothingToCollect.selector);
        gate.collect(1, _code(0)); // not for another perk
    }

    function test_claim_pickupHashIsOneTime() public {
        _join();
        gate.claim(_proof(0), 0, _nullifier(0), _pickup(0));
        // a second card cannot be claimed onto the same pickup hash (its proof is for its own hash anyway)
        bytes memory proof1 = _proof(1);
        bytes32 n1 = _nullifier(1);
        vm.expectRevert(PointsGate.PickupTaken.selector);
        gate.claim(proof1, 0, n1, _pickup(0));
    }

    function test_pickupHash_fitsTheField() public view {
        uint256 p = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        assertLt(uint256(gate.pickupHash(bytes32(type(uint256).max))), p);
        assertEq(gate.pickupHash(_code(0)), _pickup(0)); // the TypeScript side computes the same hash
    }

    function test_claim_unknownPerk() public {
        vm.expectRevert(PointsGate.UnknownPerk.selector);
        gate.claim("", 9, bytes32(0), bytes32(uint256(1)));
    }

    function test_addPerk_onlyAdmin() public {
        vm.prank(treasurer);
        vm.expectRevert(PointsGate.NotAdmin.selector);
        gate.addPerk(1, 1, "free");
        assertEq(gate.perkCount(), 1);
    }

    function test_claim_gas() public {
        _join();
        bytes memory proof = _proof(0);
        bytes32 n = _nullifier(0);
        uint256 g = gasleft();
        gate.claim(proof, 0, n, _pickup(0));
        emit log_named_uint("PointsGate.claim gas (incl. UltraHonk verify)", g - gasleft());
    }
}
