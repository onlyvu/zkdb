use zkdb::ops::{apply_op, OP_WIDTH, OpWitness};

global K: u32 = 16;

fn main(
    old_root: pub Field,
    new_root: pub Field,
    ok: pub [bool; K],
    ops: pub [[Field; OP_WIDTH]; K],
    witnesses: [OpWitness; K],
) {
    let mut root = old_root;
    for i in 0..K {
        let (next, op_ok) = apply_op(root, ops[i], witnesses[i]);
        assert(ok[i] == op_ok, "ok flag mismatch");
        root = next;
    }
    assert(root == new_root, "new root mismatch");
}

#[test]
fn all_noop_batch_keeps_root() {
    let r = zkdb::merkle::empty_root();
    let w = OpWitness { is_empty: true, table_id: 0, row: [0; 6], siblings: [0; 20] };
    main(r, r, [true; K], [[0; OP_WIDTH]; K], [w; K]);
}

#[test(should_fail_with = "new root mismatch")]
fn wrong_new_root_rejected() {
    let r = zkdb::merkle::empty_root();
    let w = OpWitness { is_empty: true, table_id: 0, row: [0; 6], siblings: [0; 20] };
    main(r, r + 1, [true; K], [[0; OP_WIDTH]; K], [w; K]);
}
