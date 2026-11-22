// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZkDB} from "../src/ZkDB.sol";
import {AdminGovernor} from "../src/AdminGovernor.sol";
import {IHonkVerifier} from "../src/IHonkVerifier.sol";

contract AdminGovernorTest is Test {
    ZkDB db;
    AdminGovernor gov;
    address deployer = address(this);
    address s1 = address(0xA1);
    address s2 = address(0xA2);
    address s3 = address(0xA3);
    address outsider = address(0xBAD);
    address writer = address(0xBEEF);
    address auditor = address(0xA0D17);
    uint64 constant DELAY = 1 hours;

    function setUp() public {
        db = new ZkDB(IHonkVerifier(address(0x1234)), bytes32(uint256(1)));
        // Pre-governance setup by the deployer key, as on the live deployment.
        db.setWriter(writer, true);
        db.setTableOwner(1, writer);
        db.setTableAuditor(1, auditor);

        address[] memory signers = new address[](3);
        signers[0] = s1;
        signers[1] = s2;
        signers[2] = s3;
        gov = new AdminGovernor(signers, 2, DELAY);

        // Handover: the old key starts the transfer, the governor accepts through its own 2-of-3 + delay.
        db.transferOwnership(address(gov));
        _pass(address(db), abi.encodeCall(ZkDB.acceptOwnership, ()));
        assertEq(db.owner(), address(gov));
    }

    /// propose by s1, approve by s2, wait out the delay, execute. Returns the action id.
    function _pass(address target, bytes memory data) internal returns (uint256 id) {
        vm.prank(s1);
        id = gov.propose(target, data);
        vm.prank(s2);
        gov.approve(id);
        vm.warp(block.timestamp + DELAY);
        gov.execute(id);
    }

    function _proposeAndApprove(address target, bytes memory data) internal returns (uint256 id) {
        vm.prank(s1);
        id = gov.propose(target, data);
        vm.prank(s2);
        gov.approve(id);
    }

    // ------------------------------------------------ the old single key has no power left

    function test_oldOwnerKey_cannotTurnOffAuditor() public {
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setTableAuditor(1, address(0));
    }

    function test_oldOwnerKey_cannotSetWriterOrTableOwnerOrTransfer() public {
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setWriter(outsider, true);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setTableOwner(2, writer);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.transferOwnership(outsider);
    }

    function test_singleSigner_cannotCallZkDBDirectly() public {
        vm.prank(s1);
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setTableAuditor(1, address(0));
    }

    // ------------------------------------------------ auditor rule off / on

    function test_turnOffAuditor_needsTwoSignersAndDelay() public {
        bytes memory data = abi.encodeCall(ZkDB.setTableAuditor, (1, address(0)));
        vm.prank(s1);
        uint256 id = gov.propose(address(db), data);

        // One signature: never executable, even after the delay.
        vm.warp(block.timestamp + DELAY + 1);
        vm.expectRevert(AdminGovernor.NotReady.selector);
        gov.execute(id);

        // Two signatures: the clock starts now.
        vm.prank(s2);
        gov.approve(id);
        vm.expectRevert(AdminGovernor.NotReady.selector);
        gov.execute(id);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(AdminGovernor.NotReady.selector);
        gov.execute(id);

        vm.warp(block.timestamp + 1);
        vm.prank(outsider); // anyone may execute once it is ready
        gov.execute(id);
        assertEq(db.tableAuditor(1), address(0));
    }

    function test_turnOnAuditor_viaGovernor() public {
        _pass(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, address(0))));
        _pass(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, auditor)));
        assertEq(db.tableAuditor(1), auditor);
    }

    function test_changeAuditor_viaGovernor() public {
        address newAuditor = address(0xA0D18);
        _pass(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, newAuditor)));
        assertEq(db.tableAuditor(1), newAuditor);
    }

    function test_cancel_byOneSigner_blocksAuditorOff() public {
        uint256 id = _proposeAndApprove(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, address(0))));
        vm.prank(s3);
        gov.cancel(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(AdminGovernor.ActionClosed.selector);
        gov.execute(id);
        assertEq(db.tableAuditor(1), auditor);
    }

    function test_soloLimit_setAndLiftOnlyViaGovernor() public {
        vm.expectRevert(ZkDB.NotOwner.selector);
        db.setSoloLimit(1, true, 1, 100, 500);
        _pass(address(db), abi.encodeCall(ZkDB.setSoloLimit, (1, true, 1, 100, 500)));
        (bool on,,,) = db.soloLimit(1);
        assertTrue(on);
        // Lifting it is the same two signatures plus delay.
        uint256 id = _proposeAndApprove(address(db), abi.encodeCall(ZkDB.setSoloLimit, (1, false, 1, 0, 0)));
        vm.expectRevert(AdminGovernor.NotReady.selector);
        gov.execute(id);
        vm.warp(block.timestamp + DELAY);
        gov.execute(id);
        (on,,,) = db.soloLimit(1);
        assertFalse(on);
    }

    // ------------------------------------------------ writers, table owners, ownership

    function test_setWriter_viaGovernor() public {
        _pass(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));
        assertTrue(db.isWriter(outsider));
        _pass(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, false)));
        assertFalse(db.isWriter(outsider));
    }

    function test_setTableOwner_viaGovernor() public {
        _pass(address(db), abi.encodeCall(ZkDB.setTableOwner, (2, writer)));
        assertEq(db.tableOwner(2), writer);
    }

    function test_rejectedCall_bubblesUpAndLeavesActionOpen() public {
        // outsider is not a writer: ZkDB refuses, the governor reverts with ZkDB's reason.
        uint256 id = _proposeAndApprove(address(db), abi.encodeCall(ZkDB.setTableOwner, (2, outsider)));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AdminGovernor.CallFailed.selector, abi.encodeWithSelector(ZkDB.NotWriter.selector)));
        gov.execute(id);
        assertEq(db.tableOwner(2), address(0));
    }

    function test_transferOwnership_viaGovernor() public {
        _pass(address(db), abi.encodeCall(ZkDB.transferOwnership, (outsider)));
        assertEq(db.pendingOwner(), outsider);
        vm.prank(outsider);
        db.acceptOwnership();
        assertEq(db.owner(), outsider);
    }

    // ------------------------------------------------ governor rules

    function test_outsider_cannotProposeApproveOrCancel() public {
        vm.prank(outsider);
        vm.expectRevert(AdminGovernor.NotSigner.selector);
        gov.propose(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));

        vm.prank(s1);
        uint256 id = gov.propose(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));
        vm.prank(outsider);
        vm.expectRevert(AdminGovernor.NotSigner.selector);
        gov.approve(id);
        vm.prank(outsider);
        vm.expectRevert(AdminGovernor.NotSigner.selector);
        gov.cancel(id);
    }

    function test_sameSigner_cannotApproveTwice() public {
        vm.prank(s1);
        uint256 id = gov.propose(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));
        vm.prank(s1);
        vm.expectRevert(AdminGovernor.AlreadyApproved.selector);
        gov.approve(id);
    }

    function test_executedAction_cannotRunAgain() public {
        uint256 id = _pass(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));
        vm.expectRevert(AdminGovernor.ActionClosed.selector);
        gov.execute(id);
    }

    function test_readyAction_expiresAfterGrace() public {
        uint256 id = _proposeAndApprove(address(db), abi.encodeCall(ZkDB.setWriter, (outsider, true)));
        vm.warp(block.timestamp + DELAY + gov.GRACE() + 1);
        vm.expectRevert(AdminGovernor.Expired.selector);
        gov.execute(id);
    }

    function test_unknownAction_reverts() public {
        vm.expectRevert(AdminGovernor.UnknownAction.selector);
        gov.execute(999);
    }

    function test_constructor_rejectsBadConfig() public {
        address[] memory one = new address[](1);
        one[0] = s1;
        vm.expectRevert(AdminGovernor.BadConfig.selector);
        new AdminGovernor(one, 1, DELAY); // threshold 1 is a single key

        address[] memory two = new address[](2);
        two[0] = s1;
        two[1] = s2;
        vm.expectRevert(AdminGovernor.BadConfig.selector);
        new AdminGovernor(two, 3, DELAY); // threshold above signer count

        vm.expectRevert(AdminGovernor.BadConfig.selector);
        new AdminGovernor(two, 2, uint64(31 days)); // delay above MAX_DELAY

        two[1] = s1;
        vm.expectRevert(AdminGovernor.BadConfig.selector);
        new AdminGovernor(two, 2, DELAY); // duplicate signer
    }

    // ------------------------------------------------ self-administration

    function test_selfAdmin_directCallsRevert() public {
        vm.prank(s1);
        vm.expectRevert(AdminGovernor.NotSelf.selector);
        gov.addSigner(outsider);
        vm.prank(s1);
        vm.expectRevert(AdminGovernor.NotSelf.selector);
        gov.removeSigner(s3);
        vm.prank(s1);
        vm.expectRevert(AdminGovernor.NotSelf.selector);
        gov.setThreshold(3);
        vm.prank(s1);
        vm.expectRevert(AdminGovernor.NotSelf.selector);
        gov.setDelay(0);
    }

    function test_selfAdmin_addRemoveSignerThresholdDelay() public {
        address s4 = address(0xA4);
        _pass(address(gov), abi.encodeCall(AdminGovernor.addSigner, (s4)));
        assertTrue(gov.isSigner(s4));
        assertEq(gov.signers().length, 4);

        _pass(address(gov), abi.encodeCall(AdminGovernor.setThreshold, (3)));
        assertEq(gov.threshold(), 3);

        // Now 2 signatures are not enough.
        uint256 id = _proposeAndApprove(address(gov), abi.encodeCall(AdminGovernor.removeSigner, (s4)));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(AdminGovernor.NotReady.selector);
        gov.execute(id);
        vm.prank(s3);
        gov.approve(id);
        vm.warp(block.timestamp + DELAY);
        gov.execute(id);
        assertFalse(gov.isSigner(s4));
        assertEq(gov.signers().length, 3);
    }

    function test_selfAdmin_setDelay() public {
        _pass(address(gov), abi.encodeCall(AdminGovernor.setDelay, (uint64(2 hours))));
        assertEq(gov.delay(), 2 hours);
    }

    function test_selfAdmin_cannotDropBelowTwoOrBelowThreshold() public {
        uint256 id = _proposeAndApprove(address(gov), abi.encodeCall(AdminGovernor.setThreshold, (1)));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AdminGovernor.CallFailed.selector, abi.encodeWithSelector(AdminGovernor.BadConfig.selector)));
        gov.execute(id);

        _pass(address(gov), abi.encodeCall(AdminGovernor.removeSigner, (s3)));
        // Two signers left, threshold 2: removing another would leave a single key.
        id = _proposeAndApprove(address(gov), abi.encodeCall(AdminGovernor.removeSigner, (s2)));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AdminGovernor.CallFailed.selector, abi.encodeWithSelector(AdminGovernor.BadConfig.selector)));
        gov.execute(id);
    }

    function test_signerChange_invalidatesPendingActions() public {
        uint256 pending = _proposeAndApprove(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, address(0))));
        _pass(address(gov), abi.encodeCall(AdminGovernor.removeSigner, (s3)));
        vm.expectRevert(AdminGovernor.StaleEpoch.selector);
        gov.execute(pending);
        assertEq(db.tableAuditor(1), auditor);
    }

    function test_removedSigner_losesPower() public {
        _pass(address(gov), abi.encodeCall(AdminGovernor.removeSigner, (s3)));
        vm.prank(s3);
        vm.expectRevert(AdminGovernor.NotSigner.selector);
        gov.propose(address(db), abi.encodeCall(ZkDB.setTableAuditor, (1, address(0))));
    }
}
