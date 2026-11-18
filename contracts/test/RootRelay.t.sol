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
import {ITeleporterMessenger, ITeleporterReceiver, TeleporterMessageInput} from "../src/icm/ITeleporter.sol";

/// Stands in for TeleporterMessenger on both chains: keeps the last message and hands it to the receiver the way
/// the real messenger does (source chain id, sender address, payload).
contract MockTeleporter is ITeleporterMessenger {
    bytes32 public immutable sourceChain;
    TeleporterMessageInput public last;
    address public lastSender;
    uint256 public sent;

    constructor(bytes32 sourceChain_) {
        sourceChain = sourceChain_;
    }

    function sendCrossChainMessage(TeleporterMessageInput calldata m) external returns (bytes32) {
        last = m;
        lastSender = msg.sender;
        return bytes32(++sent);
    }

    function deliver() external {
        ITeleporterReceiver(last.destinationAddress).receiveTeleporterMessage{gas: last.requiredGasLimit}(sourceChain, lastSender, last.message);
    }

    function deliverAs(bytes32 chain, address sender, address to, bytes calldata message) external {
        ITeleporterReceiver(to).receiveTeleporterMessage(chain, sender, message);
    }
}

contract RootRelayTest is Test {
    bytes32 constant FUJI = 0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5;
    bytes32 constant DISPATCH = 0x9f3be606497285d0ffbb5ac9ba24aa60346a9b1812479ed66cb329f394a4b1c7;

    ZkDB db;
    MockTeleporter teleporter;
    RootRelay relay;
    RootMirror mirror;
    string json;
    address treasurer = address(0xBEEF);

    function setUp() public {
        json = vm.readFile("test/fixtures/claim_1.json");
        db = new ZkDB(IHonkVerifier(address(new BatchVerifier())), vm.parseJsonBytes32(json, ".emptyRoot"));
        db.setWriter(treasurer, true);
        db.setTableOwner(1, treasurer);
        teleporter = new MockTeleporter(FUJI);
        // The mirror's address is known before it exists (next contract this test creates after the relay).
        address mirrorAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        relay = new RootRelay(IProvenRoot(address(db)), teleporter, DISPATCH, mirrorAt);
        mirror = new RootMirror(address(teleporter), FUJI, address(relay));
        assertEq(address(mirror), mirrorAt);
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

    function test_relay_sendsTheProvenRootToTheMirror() public {
        _proveBatch();
        vm.expectEmit(true, true, false, true);
        emit RootRelay.RootRelayed(1, db.root(), bytes32(uint256(1)));
        vm.prank(address(0x1234)); // anyone
        relay.relay();

        (bytes32 dest, address to,, uint256 gasLimit, bytes memory message) = teleporter.last();
        assertEq(dest, DISPATCH);
        assertEq(to, address(mirror));
        assertEq(gasLimit, 200_000);
        assertEq(message, abi.encode(uint64(1), db.root()));
        assertEq(teleporter.lastSender(), address(relay));
    }

    function test_relay_nothingToSendWithoutANewProof() public {
        vm.expectRevert(RootRelay.NothingNew.selector);
        relay.relay();
        _proveBatch();
        relay.relay();
        vm.expectRevert(RootRelay.NothingNew.selector);
        relay.relay();
        assertEq(teleporter.sent(), 1);
    }

    function test_mirror_takesTheRootOnlyFromTheRelayOverTeleporter() public {
        _proveBatch();
        relay.relay();
        teleporter.deliver();
        assertEq(mirror.root(), db.root());
        assertEq(mirror.batchNo(), 1);

        bytes memory forged = abi.encode(uint64(9), bytes32(uint256(0xBAD)));
        vm.expectRevert(RootMirror.NotTeleporter.selector);
        mirror.receiveTeleporterMessage(FUJI, address(relay), forged);
        vm.expectRevert(RootMirror.WrongSource.selector);
        teleporter.deliverAs(FUJI, address(0xBAD), address(mirror), forged);
        vm.expectRevert(RootMirror.WrongSource.selector);
        teleporter.deliverAs(DISPATCH, address(relay), address(mirror), forged);
        assertEq(mirror.root(), db.root());
    }

    function test_mirror_ignoresAnOlderRoot() public {
        teleporter.deliverAs(FUJI, address(relay), address(mirror), abi.encode(uint64(5), bytes32(uint256(5))));
        teleporter.deliverAs(FUJI, address(relay), address(mirror), abi.encode(uint64(3), bytes32(uint256(3))));
        assertEq(mirror.batchNo(), 5);
        assertEq(mirror.root(), bytes32(uint256(5)));
    }

    /// The reason to relay a root: a gate on the other chain accepts the same zero-knowledge claim, with no access
    /// to ZkDB, its op log or the club.
    function test_gateOnTheOtherChain_acceptsAClaimAgainstTheMirroredRoot() public {
        PointsGate gate = new PointsGate(IRootSource(address(mirror)), IHonkVerifier(address(new ClaimVerifier())));
        gate.addPerk(1, 500, "Priority event ticket");
        bytes memory proof = vm.parseJsonBytes(json, ".claims[0].proof");
        bytes32 nullifier = vm.parseJsonBytes32(json, ".claims[0].nullifier");
        bytes32 pickup = vm.parseJsonBytes32(json, ".claims[0].pickup");

        vm.expectRevert();
        gate.claim(proof, 0, nullifier, pickup); // nothing mirrored yet

        _proveBatch();
        relay.relay();
        teleporter.deliver();
        gate.claim(proof, 0, nullifier, pickup);
        assertTrue(gate.claimed(0, nullifier));
    }

    function test_mirror_receiveFitsTheGasLimit() public {
        _proveBatch();
        relay.relay();
        uint256 g = gasleft();
        teleporter.deliver();
        emit log_named_uint("RootMirror receive gas (limit 200,000)", g - gasleft());
    }
}
