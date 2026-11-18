// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZkDB} from "../src/ZkDB.sol";
import {IHonkVerifier} from "../src/IHonkVerifier.sol";
import {BatchVerifier} from "../src/verifiers/BatchVerifier.sol";

contract ZkDBTest is Test {
    ZkDB db;
    string json;
    address writer = address(0xBEEF);
    address writer2 = address(0xCAFE);
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function setUp() public {
        json = vm.readFile("test/fixtures/batch_1.json");
        BatchVerifier v = new BatchVerifier();
        db = new ZkDB(IHonkVerifier(address(v)), vm.parseJsonBytes32(json, ".emptyRoot"));
        db.setWriter(writer, true);
        db.setTableOwner(1, writer);
        db.setTableOwner(2, writer);
    }

    function _ops() internal view returns (uint256[9][] memory ops) {
        uint256 n = vm.parseJsonUint(json, ".nRealOps");
        uint256[] memory flat = vm.parseJsonUintArray(json, ".realOpsFlat");
        ops = new uint256[9][](n);
        for (uint256 i = 0; i < n; i++) for (uint256 j = 0; j < 9; j++) ops[i][j] = flat[i * 9 + j];
    }

    function _ok() internal view returns (bool[16] memory ok) {
        uint256[] memory raw = vm.parseJsonUintArray(json, ".ok");
        for (uint256 i = 0; i < 16; i++) ok[i] = raw[i] == 1;
    }

    function _enqueueAll(uint256[9][] memory ops) internal {
        vm.startPrank(writer);
        for (uint256 i = 0; i < ops.length; i++) {
            uint256[6] memory v;
            for (uint256 j = 0; j < 6; j++) v[j] = ops[i][3 + j];
            if (ops[i][0] == 1) {
                (uint64 rowId,) = db.insert(ops[i][2], v);
                assertEq(rowId, ops[i][1]);
            } else {
                db.enqueue(uint8(ops[i][0]), uint64(ops[i][1]), ops[i][2], v);
            }
        }
        vm.stopPrank();
    }

    function test_submitBatch_acceptsValidProof() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        db.submitBatch(vm.parseJsonBytes(json, ".proof"), newRoot, _ok(), ops);
        assertEq(db.root(), newRoot);
        assertEq(db.head(), ops.length);
        assertEq(db.batchCount(), 1);
        assertTrue(db.rootSeen(newRoot));
        assertEq(db.rootLatestBatch(newRoot), 1);
        assertEq(db.headAfterBatch(1), ops.length);
    }

    function test_submitBatch_rejectsWrongNewRoot() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        bytes memory proof = vm.parseJsonBytes(json, ".proof");
        vm.expectRevert();
        db.submitBatch(proof, bytes32(uint256(123)), _ok(), ops);
    }

    function test_submitBatch_rejectsFlippedOk() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        bool[16] memory ok = _ok();
        ok[3] = true; // op 3 really failed
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        bytes memory proof = vm.parseJsonBytes(json, ".proof");
        vm.expectRevert();
        db.submitBatch(proof, newRoot, ok, ops);
    }

    function test_submitBatch_rejectsOpsNotInQueue() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        ops[2][3] = 2; // ADD 2 instead of 1
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        bytes memory proof = vm.parseJsonBytes(json, ".proof");
        vm.expectRevert(abi.encodeWithSelector(ZkDB.OpMismatch.selector, 2));
        db.submitBatch(proof, newRoot, _ok(), ops);
    }

    function test_submitBatch_rejectsReplay() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        bytes memory proof = vm.parseJsonBytes(json, ".proof");
        db.submitBatch(proof, newRoot, _ok(), ops);
        vm.expectRevert(ZkDB.TooManyOps.selector);
        db.submitBatch(proof, newRoot, _ok(), ops);
        assertEq(db.batchCount(), 1);
    }

    function test_submitBatch_partialQueue() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        // one extra op still pending must not be required by this batch
        uint256[6] memory v;
        vm.prank(writer);
        db.enqueue(3, 0, 4, v);
        db.submitBatch(vm.parseJsonBytes(json, ".proof"), vm.parseJsonBytes32(json, ".newRoot"), _ok(), ops);
        assertEq(db.pendingOps(), 1);
    }

    function test_submitBatch_rejectsEmpty() public {
        uint256[9][] memory none = new uint256[9][](0);
        vm.expectRevert(ZkDB.EmptyBatch.selector);
        db.submitBatch("", bytes32(0), _ok(), none);
    }

    function test_enqueue_onlyWriter() public {
        uint256[6] memory v;
        vm.expectRevert(ZkDB.NotWriter.selector);
        db.insert(1, v);
    }

    function test_enqueue_rejectsUnallocatedRow() public {
        uint256[6] memory v;
        vm.prank(writer);
        vm.expectRevert(ZkDB.RowOutOfRange.selector);
        db.enqueue(2, 0, 0, v);
    }

    function test_enqueue_rejectsInsertAndNoopOpcodes() public {
        uint256[6] memory v;
        vm.startPrank(writer);
        db.insert(1, v);
        vm.expectRevert(ZkDB.BadOpcode.selector);
        db.enqueue(1, 0, 0, v);
        vm.expectRevert(ZkDB.BadOpcode.selector);
        db.enqueue(0, 0, 0, v);
        vm.stopPrank();
    }

    function test_insert_rejectsFieldOverflow() public {
        uint256[6] memory v;
        v[0] = P;
        vm.prank(writer);
        vm.expectRevert(ZkDB.FieldOverflow.selector);
        db.insert(1, v);
    }

    function test_setWriter_onlyOwner() public {
        vm.prank(writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setWriter(writer, false);
    }

    function test_insert_rejectsNonOwnerTable() public {
        db.setWriter(writer2, true);
        uint256[6] memory v;
        vm.prank(writer2);
        vm.expectRevert(ZkDB.NotTableOwner.selector);
        db.insert(1, v);
    }

    function test_enqueue_rejectsOtherWritersRow() public {
        db.setWriter(writer2, true);
        db.setTableOwner(3, writer2);
        uint256[6] memory v;
        vm.prank(writer);
        db.insert(1, v);
        vm.prank(writer2);
        vm.expectRevert(ZkDB.NotTableOwner.selector);
        db.enqueue(2, 0, 0, v);
    }

    /// Round-1 audit finding: rows used to belong to the wallet that inserted them, so a new treasurer could not
    /// touch any existing member. Access now follows the table.
    function test_handover_newTableOwnerInheritsRows() public {
        uint256[6] memory v;
        vm.prank(writer);
        db.insert(1, v);

        db.setWriter(writer2, true);
        db.setTableOwner(1, writer2);

        vm.prank(writer2);
        uint64 opId = db.enqueue(3, 0, 1, v);
        assertEq(opId, 1);

        vm.prank(writer);
        vm.expectRevert(ZkDB.NotTableOwner.selector);
        db.enqueue(3, 0, 1, v);
    }

    function test_opQueued_namesTheSender() public {
        uint256[6] memory v;
        uint256[9] memory op;
        op[0] = 1;
        op[2] = 1;
        vm.expectEmit(true, true, false, true);
        emit ZkDB.OpQueued(0, writer, op);
        vm.prank(writer);
        db.insert(1, v);
    }

    // --- on an audited table, anything that overwrites or takes away needs the auditor ---

    address auditor = address(0xA0D1);

    function _memberRow() internal returns (uint256[6] memory v) {
        vm.prank(writer);
        db.insert(1, v);
        db.setTableAuditor(1, auditor);
    }

    function _correction(uint8 opcode, uint256 value) internal pure returns (uint256[9] memory op) {
        op[0] = opcode;
        op[2] = opcode == 2 ? 1 : 0;
        op[3] = value;
    }

    /// Round-2 audit PoC: SUB used to go through with one signature, so a treasurer could cut a balance by 1,000 as a
    /// "redemption". Now one signer can only add.
    function test_proposal_writerAloneCanOnlyAdd() public {
        uint256[6] memory v = _memberRow();
        v[0] = 1000;
        vm.startPrank(writer);
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.enqueue(2, 0, 1, v); // SET
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.enqueue(4, 0, 1, v); // SUB
        vm.expectRevert(ZkDB.NeedsAuditor.selector);
        db.enqueue(5, 0, 0, v); // DELETE
        db.enqueue(3, 0, 1, v); // ADD: one signature
        vm.stopPrank();
        assertEq(db.pendingOps(), 2, "the insert and the award");
    }

    function test_proposal_redemptionQueuedOnlyAfterAuditorApproves() public {
        uint256[6] memory v = _memberRow();
        v[0] = 500;
        uint256[9] memory op;
        op[0] = 4;
        op[2] = 1;
        op[3] = 500;
        vm.prank(writer);
        uint64 id = db.proposeChange(4, 0, 1, v);
        assertEq(db.pendingOps(), 1);
        vm.prank(auditor);
        db.approveChange(id, op);
        assertEq(db.pendingOps(), 2);
    }

    /// Without an auditor the table works as before: its writer overwrites and subtracts alone.
    function test_proposal_notNeededOnATableWithoutAnAuditor() public {
        uint256[6] memory v;
        vm.startPrank(writer);
        db.insert(1, v);
        db.enqueue(2, 0, 1, v);
        db.enqueue(4, 0, 1, v);
        db.enqueue(5, 0, 0, v);
        vm.stopPrank();
        assertEq(db.pendingOps(), 4);
    }

    function test_proposal_queuedOnlyAfterAuditorApproves() public {
        uint256[6] memory v = _memberRow();
        v[0] = 250;
        uint256[9] memory op = _correction(2, 250);

        vm.expectEmit(true, true, false, true);
        emit ZkDB.ChangeProposed(0, writer, op);
        vm.prank(writer);
        uint64 id = db.proposeChange(2, 0, 1, v);
        assertEq(db.pendingOps(), 1, "only the insert is queued");
        assertTrue(db.proposalOpen(id));

        vm.prank(writer);
        vm.expectRevert(ZkDB.NotAuditor.selector);
        db.approveChange(id, op);

        // the queued op names the proposer, the approval names the auditor
        vm.expectEmit(true, true, false, true);
        emit ZkDB.OpQueued(1, writer, op);
        vm.expectEmit(true, true, false, true);
        emit ZkDB.ChangeApproved(id, auditor, 1);
        vm.prank(auditor);
        db.approveChange(id, op);
        assertEq(db.pendingOps(), 2);
        assertFalse(db.proposalOpen(id));

        vm.prank(auditor);
        vm.expectRevert(ZkDB.ProposalClosed.selector);
        db.approveChange(id, op);
    }

    function test_proposal_auditorCannotChangeTheProposal() public {
        uint256[6] memory v = _memberRow();
        v[0] = 250;
        vm.prank(writer);
        uint64 id = db.proposeChange(2, 0, 1, v);
        vm.prank(auditor);
        vm.expectRevert(ZkDB.ProposalMismatch.selector);
        db.approveChange(id, _correction(2, 0));
    }

    function test_proposal_declinedCanNeverBeQueued() public {
        uint256[6] memory v = _memberRow();
        v[0] = 250;
        uint256[9] memory op = _correction(2, 250);
        vm.prank(writer);
        uint64 id = db.proposeChange(2, 0, 1, v);

        vm.prank(writer2);
        vm.expectRevert(ZkDB.NotAuditor.selector);
        db.declineChange(id, op);

        vm.expectEmit(true, true, false, true);
        emit ZkDB.ChangeDeclined(id, auditor);
        vm.prank(auditor);
        db.declineChange(id, op);

        vm.prank(auditor);
        vm.expectRevert(ZkDB.ProposalClosed.selector);
        db.approveChange(id, op);
        assertEq(db.pendingOps(), 1);
    }

    function test_proposal_proposerCanWithdraw() public {
        uint256[6] memory v = _memberRow();
        vm.prank(writer);
        uint64 id = db.proposeChange(5, 0, 0, v);
        vm.prank(writer);
        db.declineChange(id, _correction(5, 0));
        assertFalse(db.proposalOpen(id));
    }

    function test_proposal_onlyTableOwnerProposes_neverAnAward() public {
        uint256[6] memory v = _memberRow();
        db.setWriter(writer2, true);
        vm.prank(writer2);
        vm.expectRevert(ZkDB.NotTableOwner.selector);
        db.proposeChange(2, 0, 1, v);
        vm.prank(writer);
        vm.expectRevert(ZkDB.BadOpcode.selector);
        db.proposeChange(3, 0, 1, v); // an award is not a proposal
    }

    function test_auditor_cannotAlsoBeTheTableWriter() public {
        vm.expectRevert(ZkDB.AuditorIsWriter.selector);
        db.setTableAuditor(1, writer);

        db.setTableAuditor(1, auditor);
        db.setWriter(auditor, true);
        vm.expectRevert(ZkDB.AuditorIsWriter.selector);
        db.setTableOwner(1, auditor);

        vm.prank(writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setTableAuditor(1, address(0));
    }

    /// The same proof fixture, with every SET, SUB and DELETE going through propose + approve on audited tables.
    function test_submitBatch_withCoSignedCorrections() public {
        db.setTableAuditor(1, auditor);
        db.setTableAuditor(2, auditor);
        uint256[9][] memory ops = _ops();
        for (uint256 i = 0; i < ops.length; i++) {
            uint256[6] memory v;
            for (uint256 j = 0; j < 6; j++) v[j] = ops[i][3 + j];
            uint8 code = uint8(ops[i][0]);
            if (code == 1) {
                vm.prank(writer);
                db.insert(ops[i][2], v);
            } else if (code == 2 || code == 4 || code == 5) {
                vm.prank(writer);
                uint64 id = db.proposeChange(code, uint64(ops[i][1]), ops[i][2], v);
                vm.prank(auditor);
                db.approveChange(id, ops[i]);
            } else {
                vm.prank(writer);
                db.enqueue(code, uint64(ops[i][1]), ops[i][2], v);
            }
        }
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        db.submitBatch(vm.parseJsonBytes(json, ".proof"), newRoot, _ok(), ops);
        assertEq(db.root(), newRoot);
        assertEq(db.proposalCount(), 4);
    }

    // --- ownership ---

    function test_ownership_movesInTwoSteps() public {
        address safe = address(0x5AFE);
        db.transferOwnership(safe);
        assertEq(db.owner(), address(this), "nothing moves until the new owner accepts");

        vm.prank(writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.acceptOwnership();

        vm.prank(safe);
        db.acceptOwnership();
        assertEq(db.owner(), safe);
        assertEq(db.pendingOwner(), address(0));

        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setWriter(writer2, true);
    }

    function test_setTableOwner_onlyOwner() public {
        vm.prank(writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setTableOwner(5, writer);
    }

    function test_batchHead() public {
        uint256[9][] memory ops = _ops();
        _enqueueAll(ops);
        bytes32 newRoot = vm.parseJsonBytes32(json, ".newRoot");
        db.submitBatch(vm.parseJsonBytes(json, ".proof"), newRoot, _ok(), ops);
        assertEq(db.batchHead(newRoot), 7);
        assertEq(db.batchHead(vm.parseJsonBytes32(json, ".emptyRoot")), 0);
        vm.expectRevert(ZkDB.UnknownRoot.selector);
        db.batchHead(bytes32(uint256(999)));
    }
}
