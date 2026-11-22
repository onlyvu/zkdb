// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title AdminGovernor: M-of-N signers plus a timelock, meant to be the owner of ZkDB.
/// @notice No single key can change anything. An admin call (turn the auditor rule off or on, add a writer, assign a
/// table, hand ownership on) is proposed by one signer, needs `threshold` (at least 2) signers in all, and then waits
/// `delay` seconds in public before anyone may execute it. During that wait any one signer may cancel it.
///
/// The signer set, the threshold and the delay can only be changed by the governor calling itself, so through the
/// same M-of-N plus delay. Each such change starts a new epoch: actions proposed under the old signer set can no
/// longer be executed and must be proposed again.
contract AdminGovernor {
    uint256 public constant MAX_DELAY = 30 days;
    /// An action that is ready must be executed within this window, or it expires.
    uint256 public constant GRACE = 14 days;

    struct Action {
        address target;
        bytes data;
        address proposer;
        uint64 epoch;
        uint64 approvals;
        uint64 readyAt; // 0 until the threshold is reached
        bool executed;
        bool cancelled;
    }

    mapping(address => bool) public isSigner;
    address[] internal signerList;
    uint64 public threshold;
    uint64 public delay;
    uint64 public epoch;

    Action[] internal actions;
    mapping(uint256 => mapping(address => bool)) public approved;

    event Proposed(uint256 indexed id, address indexed proposer, address indexed target, bytes data);
    event Approved(uint256 indexed id, address indexed signer, uint64 approvals);
    event Ready(uint256 indexed id, uint64 readyAt);
    event Executed(uint256 indexed id, address indexed by);
    event Cancelled(uint256 indexed id, address indexed by);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdSet(uint64 threshold);
    event DelaySet(uint64 delay);

    error NotSigner();
    error NotSelf();
    error BadConfig();
    error UnknownAction();
    error ActionClosed();
    error StaleEpoch();
    error AlreadyApproved();
    error NotReady();
    error Expired();
    error CallFailed(bytes reason);

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(address[] memory signers_, uint64 threshold_, uint64 delay_) {
        for (uint256 i = 0; i < signers_.length; i++) {
            address s = signers_[i];
            if (s == address(0) || isSigner[s]) revert BadConfig();
            isSigner[s] = true;
            signerList.push(s);
            emit SignerAdded(s);
        }
        _setThreshold(threshold_);
        _setDelay(delay_);
    }

    // ---------------------------------------------------------------- actions

    /// First signature. The proposer's approval counts.
    function propose(address target, bytes calldata data) external onlySigner returns (uint256 id) {
        id = actions.length;
        actions.push(Action(target, data, msg.sender, epoch, 0, 0, false, false));
        emit Proposed(id, msg.sender, target, data);
        _approve(id);
    }

    function approve(uint256 id) external onlySigner {
        _approve(id);
    }

    /// Any one signer can stop an action before it runs.
    function cancel(uint256 id) external onlySigner {
        Action storage a = _open(id);
        a.cancelled = true;
        emit Cancelled(id, msg.sender);
    }

    /// Anyone may execute an action that has enough signatures and has waited out the delay.
    function execute(uint256 id) external returns (bytes memory result) {
        Action storage a = _open(id);
        if (a.epoch != epoch) revert StaleEpoch();
        if (a.readyAt == 0 || block.timestamp < a.readyAt) revert NotReady();
        if (block.timestamp > uint256(a.readyAt) + GRACE) revert Expired();
        a.executed = true;
        bool ok;
        (ok, result) = a.target.call(a.data);
        if (!ok) revert CallFailed(result);
        emit Executed(id, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function action(uint256 id) external view returns (Action memory) {
        if (id >= actions.length) revert UnknownAction();
        return actions[id];
    }

    function signers() external view returns (address[] memory) {
        return signerList;
    }

    // ---------------------------------------------------------------- self-administration (only via execute)

    function addSigner(address s) external onlySelf {
        if (s == address(0) || isSigner[s]) revert BadConfig();
        isSigner[s] = true;
        signerList.push(s);
        emit SignerAdded(s);
        _newEpoch();
    }

    function removeSigner(address s) external onlySelf {
        if (!isSigner[s] || signerList.length - 1 < threshold) revert BadConfig();
        isSigner[s] = false;
        for (uint256 i = 0; i < signerList.length; i++) {
            if (signerList[i] == s) {
                signerList[i] = signerList[signerList.length - 1];
                signerList.pop();
                break;
            }
        }
        emit SignerRemoved(s);
        _newEpoch();
    }

    function setThreshold(uint64 t) external onlySelf {
        _setThreshold(t);
        _newEpoch();
    }

    function setDelay(uint64 d) external onlySelf {
        _setDelay(d);
        _newEpoch();
    }

    // ---------------------------------------------------------------- internal

    function _approve(uint256 id) internal {
        Action storage a = _open(id);
        if (a.epoch != epoch) revert StaleEpoch();
        if (approved[id][msg.sender]) revert AlreadyApproved();
        approved[id][msg.sender] = true;
        a.approvals++;
        emit Approved(id, msg.sender, a.approvals);
        if (a.approvals == threshold) {
            a.readyAt = uint64(block.timestamp) + delay;
            emit Ready(id, a.readyAt);
        }
    }

    function _open(uint256 id) internal view returns (Action storage a) {
        if (id >= actions.length) revert UnknownAction();
        a = actions[id];
        if (a.executed || a.cancelled) revert ActionClosed();
    }

    function _setThreshold(uint64 t) internal {
        if (t < 2 || t > signerList.length) revert BadConfig();
        threshold = t;
        emit ThresholdSet(t);
    }

    function _setDelay(uint64 d) internal {
        if (d > MAX_DELAY) revert BadConfig();
        delay = d;
        emit DelaySet(d);
    }

    function _newEpoch() internal {
        epoch++;
    }
}
