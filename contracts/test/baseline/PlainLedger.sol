// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// The baseline zkDB is measured against (docs/gas-comparison.md): the same points ledger as ordinary contract
/// storage. Same roles, same public record per change (who, what, why, balance after), a redemption above the
/// balance is recorded as rejected and changes nothing. No proof, no queue, no Merkle root.
contract PlainLedger {
    address public immutable owner;
    address public treasurer;
    uint64 public nextRow;
    mapping(uint64 => uint64) public card;
    mapping(uint64 => uint64) public balance;

    event Joined(uint64 indexed row, address indexed by, uint64 card, uint64 points);
    event Changed(uint64 indexed row, address indexed by, uint8 kind, uint64 amount, uint64 reason, uint64 balanceAfter, bool ok);

    error NotAllowed();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyTreasurer() {
        if (msg.sender != treasurer) revert NotAllowed();
        _;
    }

    function setTreasurer(address t) external {
        if (msg.sender != owner) revert NotAllowed();
        treasurer = t;
    }

    function join(uint64 card_, uint64 points) external onlyTreasurer returns (uint64 row) {
        row = nextRow++;
        card[row] = card_;
        balance[row] = points;
        emit Joined(row, msg.sender, card_, points);
    }

    function award(uint64 row, uint64 amount, uint64 reason) external onlyTreasurer {
        uint64 b = balance[row] + amount;
        balance[row] = b;
        emit Changed(row, msg.sender, 3, amount, reason, b, true);
    }

    function redeem(uint64 row, uint64 amount, uint64 reason) external onlyTreasurer {
        uint64 b = balance[row];
        bool ok = b >= amount;
        if (ok) {
            b -= amount;
            balance[row] = b;
        }
        emit Changed(row, msg.sender, 4, amount, reason, b, ok);
    }

    function correct(uint64 row, uint64 value, uint64 reason) external onlyTreasurer {
        balance[row] = value;
        emit Changed(row, msg.sender, 2, value, reason, value, true);
    }
}
