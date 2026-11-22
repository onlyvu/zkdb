// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IHonkVerifier} from "./IHonkVerifier.sol";

/// @title ZkDB: Merkle-rooted database whose writes are applied in batches proven by the Noir zkDB-VM.
/// @notice Writers queue ops; anyone can submit a batch proof that consumes the next ≤K ops.
/// A table can have an auditor. On such a table one signer can only add: insert a row, or ADD to a field. Anything
/// that overwrites or takes away (SET, SUB, DELETE) is a proposal from the table's writer, and it enters the queue
/// only when the auditor approves the same op.
///
/// A table can also have a solo limit on one field (the balance): one signer may ADD at most `maxPerOp` to it per op
/// and at most `maxPerDay` in total per UTC day, counting the value an INSERT starts the field at. Anything above is
/// a proposal that needs the auditor, like SET, SUB and DELETE. Without a limit, ADD and INSERT are one-signer as
/// before.
contract ZkDB {
    uint256 public constant K = 16;
    uint256 public constant OP_WIDTH = 9;
    uint64 public constant MAX_ROWS = uint64(1) << 20;
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 internal constant OP_INSERT = 1;
    uint8 internal constant OP_SET = 2;
    uint8 internal constant OP_ADD = 3;
    uint8 internal constant OP_SUB = 4;
    uint8 internal constant OP_DELETE = 5;

    IHonkVerifier public immutable batchVerifier;
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isWriter;
    mapping(uint256 => address) public tableOwner;
    /// Second signer for SET, SUB and DELETE on a table. Zero means the table's writer may do them alone.
    mapping(uint256 => address) public tableAuditor;
    /// Table each row was inserted into. Access to a row follows its table, so a new table owner inherits the rows.
    mapping(uint64 => uint256) public rowTable;

    struct SoloLimit {
        bool on;
        uint8 field;
        uint64 maxPerOp;
        uint64 maxPerDay;
    }

    /// Limit on what one signer may add to a table's balance field without the auditor. Off by default.
    mapping(uint256 => SoloLimit) public soloLimit;
    /// table => UTC day number => amount added by one signer that day (ADD deltas plus INSERT starting values).
    mapping(uint256 => mapping(uint256 => uint256)) public soloAdded;

    struct Proposal {
        bytes32 opHash;
        address proposer;
        bool open;
    }

    Proposal[] internal proposals;

    bytes32 public root;
    uint64 public batchCount;
    uint64 public head;
    uint64 public nextRowId;
    bytes32[] internal opHashes;
    mapping(bytes32 => bool) public rootSeen;
    mapping(bytes32 => uint64) public rootLatestBatch;
    mapping(uint64 => uint64) public headAfterBatch;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event WriterSet(address indexed writer, bool allowed);
    event TableOwnerSet(uint256 indexed tableId, address indexed writer);
    event TableAuditorSet(uint256 indexed tableId, address indexed auditor);
    event SoloLimitSet(uint256 indexed tableId, bool on, uint8 field, uint64 maxPerOp, uint64 maxPerDay);
    /// @param by the account that asked for the change: the sender, or the proposer of an approved change.
    event OpQueued(uint64 indexed opId, address indexed by, uint256[9] op);
    event ChangeProposed(uint64 indexed id, address indexed by, uint256[9] op);
    event ChangeApproved(uint64 indexed id, address indexed by, uint64 opId);
    event ChangeDeclined(uint64 indexed id, address indexed by);
    event BatchSubmitted(uint64 indexed batchNo, bytes32 oldRoot, bytes32 newRoot, uint64 fromOp, uint64 toOp, bool[16] ok);

    error NotOwner();
    error NotWriter();
    error NotTableOwner();
    error NotAuditor();
    error NeedsAuditor();
    error AuditorIsWriter();
    error ProposalClosed();
    error ProposalMismatch();
    error BadOpcode();
    error RowOutOfRange();
    error RowLimit();
    error FieldOverflow();
    error EmptyBatch();
    error TooManyOps();
    error OpMismatch(uint256 index);
    error InvalidProof();
    error UnknownRoot();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter();
        _;
    }

    constructor(IHonkVerifier batchVerifier_, bytes32 emptyRoot) {
        batchVerifier = batchVerifier_;
        owner = msg.sender;
        root = emptyRoot;
        rootSeen[emptyRoot] = true;
    }

    /// Ownership moves in two steps, so it cannot be handed to an address nobody controls (for example a Safe that
    /// was mistyped).
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function setTableOwner(uint256 tableId, address writer) external onlyOwner {
        if (!isWriter[writer]) revert NotWriter();
        if (writer == tableAuditor[tableId]) revert AuditorIsWriter();
        tableOwner[tableId] = writer;
        emit TableOwnerSet(tableId, writer);
    }

    /// @param auditor second signer for SET, SUB and DELETE on this table; zero turns the rule off.
    function setTableAuditor(uint256 tableId, address auditor) external onlyOwner {
        if (auditor != address(0) && auditor == tableOwner[tableId]) revert AuditorIsWriter();
        tableAuditor[tableId] = auditor;
        emit TableAuditorSet(tableId, auditor);
    }

    /// @param on false removes the limit; field is the row field (0..5) the limit counts.
    function setSoloLimit(uint256 tableId, bool on, uint8 field, uint64 maxPerOp, uint64 maxPerDay) external onlyOwner {
        if (field >= 6) revert BadOpcode();
        soloLimit[tableId] = SoloLimit(on, field, maxPerOp, maxPerDay);
        emit SoloLimitSet(tableId, on, field, maxPerOp, maxPerDay);
    }

    function insert(uint256 tableId, uint256[6] calldata fields) external onlyWriter returns (uint64 rowId, uint64 opId) {
        if (tableOwner[tableId] != msg.sender) revert NotTableOwner();
        SoloLimit memory lim = soloLimit[tableId];
        if (lim.on) _countSolo(tableId, lim, fields[lim.field]);
        if (nextRowId >= MAX_ROWS) revert RowLimit();
        rowId = nextRowId++;
        rowTable[rowId] = tableId;
        uint256[9] memory op;
        op[0] = OP_INSERT;
        op[1] = rowId;
        op[2] = tableId;
        for (uint256 i = 0; i < 6; i++) op[3 + i] = fields[i];
        opId = _push(op, msg.sender);
    }

    /// Queues SET, ADD, SUB or DELETE on a row of a table the sender owns. On a table with an auditor only ADD goes
    /// through; SET, SUB and DELETE revert with NeedsAuditor: use proposeChange. An ADD above the table's solo limit
    /// also reverts with NeedsAuditor.
    function enqueue(uint8 opcode, uint64 rowId, uint256 a, uint256[6] calldata v) external onlyWriter returns (uint64 opId) {
        uint256[9] memory op = _rowOp(opcode, rowId, a, v);
        uint256 tableId = rowTable[rowId];
        if (_needsAuditor(opcode) && tableAuditor[tableId] != address(0)) revert NeedsAuditor();
        if (opcode == OP_ADD) {
            SoloLimit memory lim = soloLimit[tableId];
            if (lim.on && a == lim.field) _countSolo(tableId, lim, v[0]);
        }
        opId = _push(op, msg.sender);
    }

    /// First signature of a change that overwrites or takes away (SET, SUB or DELETE), or of an ADD above the solo
    /// limit. Nothing is queued until the table's auditor approves.
    function proposeChange(uint8 opcode, uint64 rowId, uint256 a, uint256[6] calldata v) external onlyWriter returns (uint64 id) {
        uint256[9] memory op = _rowOp(opcode, rowId, a, v);
        // An ADD is a proposal only on a table with a solo limit; elsewhere one signer queues it with enqueue.
        if (!_needsAuditor(opcode) && !(opcode == OP_ADD && soloLimit[rowTable[rowId]].on)) revert BadOpcode();
        _checkFields(op);
        id = uint64(proposals.length);
        proposals.push(Proposal(keccak256(abi.encode(op)), msg.sender, true));
        emit ChangeProposed(id, msg.sender, op);
    }

    /// Second signature: the auditor of the row's table puts the proposed op into the queue, unchanged.
    function approveChange(uint64 id, uint256[9] calldata op) external returns (uint64 opId) {
        Proposal storage c = _openProposal(id, op);
        if (msg.sender != tableAuditor[rowTable[uint64(op[1])]]) revert NotAuditor();
        c.open = false;
        opId = _push(op, c.proposer);
        emit ChangeApproved(id, msg.sender, opId);
    }

    /// The auditor refuses a proposal, or the proposer withdraws it. It can never be queued afterwards.
    function declineChange(uint64 id, uint256[9] calldata op) external {
        Proposal storage c = _openProposal(id, op);
        if (msg.sender != tableAuditor[rowTable[uint64(op[1])]] && msg.sender != c.proposer) revert NotAuditor();
        c.open = false;
        emit ChangeDeclined(id, msg.sender);
    }

    function proposalCount() external view returns (uint64) {
        return uint64(proposals.length);
    }

    function proposalOpen(uint64 id) external view returns (bool) {
        return id < proposals.length && proposals[id].open;
    }

    /// @notice Number of ops consumed once `r` became the root (genesis root -> 0).
    function batchHead(bytes32 r) external view returns (uint64) {
        if (!rootSeen[r]) revert UnknownRoot();
        return headAfterBatch[rootLatestBatch[r]];
    }

    function pendingOps() external view returns (uint64) {
        return uint64(opHashes.length) - head;
    }

    /// @param ops exactly the next ops.length (1..K) queued ops, in order; remaining slots are NOOP padding.
    function submitBatch(bytes calldata proof, bytes32 newRoot, bool[16] calldata ok, uint256[9][] calldata ops) external {
        uint256 n = ops.length;
        if (n == 0) revert EmptyBatch();
        if (n > K || head + n > opHashes.length) revert TooManyOps();

        bytes32[] memory pi = new bytes32[](2 + K + K * OP_WIDTH);
        pi[0] = root;
        pi[1] = newRoot;
        for (uint256 i = 0; i < K; i++) {
            pi[2 + i] = ok[i] ? bytes32(uint256(1)) : bytes32(0);
        }
        for (uint256 i = 0; i < n; i++) {
            if (keccak256(abi.encode(ops[i])) != opHashes[head + i]) revert OpMismatch(i);
            for (uint256 j = 0; j < OP_WIDTH; j++) {
                pi[2 + K + i * OP_WIDTH + j] = bytes32(ops[i][j]);
            }
        }
        if (!batchVerifier.verify(proof, pi)) revert InvalidProof();

        uint64 fromOp = head;
        head += uint64(n);
        batchCount++;
        bytes32 oldRoot = root;
        root = newRoot;
        rootSeen[newRoot] = true;
        rootLatestBatch[newRoot] = batchCount;
        headAfterBatch[batchCount] = head;
        emit BatchSubmitted(batchCount, oldRoot, newRoot, fromOp, head, ok);
    }

    /// Ops one signer cannot queue on an audited table: everything except ADD (INSERT has its own function).
    function _needsAuditor(uint8 opcode) internal pure returns (bool) {
        return opcode == OP_SET || opcode == OP_SUB || opcode == OP_DELETE;
    }

    /// Builds a row op and checks the sender owns the row's table today.
    function _rowOp(uint8 opcode, uint64 rowId, uint256 a, uint256[6] calldata v) internal view returns (uint256[9] memory op) {
        if (opcode < OP_SET || opcode > OP_DELETE) revert BadOpcode();
        if (rowId >= nextRowId) revert RowOutOfRange();
        if (tableOwner[rowTable[rowId]] != msg.sender) revert NotTableOwner();
        op[0] = opcode;
        op[1] = rowId;
        op[2] = a;
        for (uint256 i = 0; i < 6; i++) op[3 + i] = v[i];
    }

    /// One signer's addition to the limited field: within maxPerOp and within today's maxPerDay, or NeedsAuditor.
    function _countSolo(uint256 tableId, SoloLimit memory lim, uint256 amount) internal {
        if (amount == 0) return;
        uint256 day = block.timestamp / 1 days;
        uint256 total = soloAdded[tableId][day] + amount;
        if (amount > lim.maxPerOp || total > lim.maxPerDay) revert NeedsAuditor();
        soloAdded[tableId][day] = total;
    }

    function _openProposal(uint64 id, uint256[9] calldata op) internal view returns (Proposal storage c) {
        if (id >= proposals.length) revert ProposalClosed();
        c = proposals[id];
        if (!c.open) revert ProposalClosed();
        if (keccak256(abi.encode(op)) != c.opHash) revert ProposalMismatch();
    }

    function _checkFields(uint256[9] memory op) internal pure {
        for (uint256 i = 0; i < OP_WIDTH; i++) {
            if (op[i] >= P) revert FieldOverflow();
        }
    }

    function _push(uint256[9] memory op, address by) internal returns (uint64 opId) {
        _checkFields(op);
        opId = uint64(opHashes.length);
        opHashes.push(keccak256(abi.encode(op)));
        emit OpQueued(opId, by, op);
    }
}
