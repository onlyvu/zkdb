// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZkDB} from "../src/ZkDB.sol";
import {IHonkVerifier} from "../src/IHonkVerifier.sol";

/// One signer may only add a bounded amount to the balance field; above that the auditor must co-sign.
contract SoloLimitTest is Test {
    ZkDB db;
    address writer = address(0xBEEF);
    address auditor = address(0xA0D1);
    uint8 constant BAL = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        db = new ZkDB(IHonkVerifier(address(0x1234)), bytes32(uint256(1)));
        db.setWriter(writer, true);
        db.setTableOwner(1, writer);
        db.setTableAuditor(1, auditor);
        db.setSoloLimit(1, true, BAL, 100, 250);
    }

    function _add(uint256 amount) internal returns (uint64) {
        uint256[6] memory v;
        v[0] = amount;
        vm.prank(writer);
        return db.enqueue(3, 0, BAL, v);
    }

    function _insert(uint256 startBalance) internal {
        uint256[6] memory f;
        f[0] = 42; // card number
        f[BAL] = startBalance;
        f[2] = type(uint128).max; // card key: large, but not the limited field
        vm.prank(writer);
        db.insert(1, f);
    }

    function test_add_withinLimit_oneSigner() public {
        _insert(0);
        _add(100);
        _add(100);
        assertEq(db.pendingOps(), 3);
        assertEq(db.soloAdded(1, block.timestamp / 1 days), 200);
    }

    function test_add_abovePerOp_needsAuditor() public {
        _insert(0);
        uint256[6] memory v;
        v[0] = 101;
        vm.prank(writer);
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.enqueue(3, 0, BAL, v);
    }

    function test_add_manySmallAdds_hitTheDailyCap() public {
        _insert(0);
        _add(100);
        _add(100);
        _add(50);
        uint256[6] memory v;
        v[0] = 1;
        vm.prank(writer);
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.enqueue(3, 0, BAL, v);
        // The next UTC day the budget is fresh.
        vm.warp(block.timestamp + 1 days);
        _add(100);
    }

    function test_insert_startingBalanceCountsAndIsCapped() public {
        _insert(100);
        assertEq(db.soloAdded(1, block.timestamp / 1 days), 100);
        uint256[6] memory f;
        f[BAL] = 101;
        vm.prank(writer);
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.insert(1, f);
    }

    function test_add_aboveLimit_goesThroughAuditor() public {
        _insert(0);
        uint256[6] memory v;
        v[0] = 5000;
        vm.prank(writer);
        uint64 id = db.proposeChange(3, 0, BAL, v);
        assertEq(db.pendingOps(), 1, "nothing queued yet");

        uint256[9] memory op;
        op[0] = 3;
        op[2] = BAL;
        op[3] = 5000;
        vm.prank(writer);
        vm.expectRevert(ZkDB.NotAuditor.selector);
        db.approveChange(id, op);
        vm.prank(auditor);
        db.approveChange(id, op);
        assertEq(db.pendingOps(), 2);
        assertEq(db.soloAdded(1, block.timestamp / 1 days), 0, "co-signed adds do not use the solo budget");
    }

    function test_add_otherField_notLimited() public {
        _insert(0);
        uint256[6] memory v;
        v[0] = 1_000_000;
        vm.prank(writer);
        db.enqueue(3, 0, 3, v);
    }

    function test_limitOff_behavesAsBefore() public {
        db.setSoloLimit(1, false, BAL, 0, 0);
        _insert(1_000_000);
        _add(1_000_000);
        uint256[6] memory v;
        vm.prank(writer);
        vm.expectRevert(ZkDB.BadOpcode.selector);
        db.proposeChange(3, 0, BAL, v); // without a limit an ADD is not a proposal, as before
    }

    function test_setSoloLimit_onlyOwner_andFieldInRange() public {
        vm.prank(writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setSoloLimit(1, false, BAL, 0, 0);
        vm.expectRevert(ZkDB.BadOpcode.selector);
        db.setSoloLimit(1, true, 6, 1, 1);
    }

    function test_setSoloLimit_emits() public {
        vm.expectEmit(true, false, false, true);
        emit ZkDB.SoloLimitSet(2, true, BAL, 10, 20);
        db.setSoloLimit(2, true, BAL, 10, 20);
        (bool on, uint8 field, uint64 perOp, uint64 perDay) = db.soloLimit(2);
        assertTrue(on);
        assertEq(field, BAL);
        assertEq(perOp, 10);
        assertEq(perDay, 20);
    }
}
