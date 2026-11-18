use crate::merkle::{compute_root, empty_root, zero_siblings};
use crate::hash::hash_leaf;

pub global ROW_WIDTH: u32 = 6;
pub global OP_WIDTH: u32 = 9;

pub struct OpWitness {
    pub is_empty: bool,
    pub table_id: Field,
    pub row: [Field; ROW_WIDTH],
    pub siblings: [Field; crate::merkle::DEPTH],
}

fn is_u64(x: Field) -> bool {
    (x as u64) as Field == x
}

fn get_field(row: [Field; ROW_WIDTH], idx: Field) -> (Field, bool) {
    let mut v = 0;
    let mut found = false;
    for i in 0..ROW_WIDTH {
        if idx == i as Field {
            v = row[i];
            found = true;
        }
    }
    (v, found)
}

fn put_field(row: [Field; ROW_WIDTH], idx: Field, value: Field) -> [Field; ROW_WIDTH] {
    let mut out = row;
    for i in 0..ROW_WIDTH {
        if idx == i as Field {
            out[i] = value;
        }
    }
    out
}

/// Apply one zkDB-VM op. A failed op leaves the root unchanged and returns ok=false;
/// the witness is bound to the root, so the prover cannot fake a failure.
pub fn apply_op(root: Field, op: [Field; OP_WIDTH], w: OpWitness) -> (Field, bool) {
    let opcode = op[0];
    let row_id = op[1];
    let a = op[2];
    let v0 = op[3];
    let is_noop = opcode == 0;

    let cur_leaf = if w.is_empty { 0 } else { hash_leaf(w.table_id, w.row) };
    let path_root = compute_root(cur_leaf, if is_noop { 0 } else { row_id }, w.siblings);
    assert(is_noop | (path_root == root), "witness path does not match root");

    let (cur, found) = get_field(w.row, a);
    let mut new_table = w.table_id;
    let mut new_row = w.row;
    let mut new_empty = w.is_empty;
    let mut ok = false;

    if opcode == 1 {
        ok = w.is_empty;
        new_table = a;
        for i in 0..ROW_WIDTH {
            new_row[i] = op[3 + i];
        }
        new_empty = false;
    } else if opcode == 2 {
        ok = !w.is_empty & found;
        new_row = put_field(w.row, a, v0);
    } else if opcode == 3 {
        let sum = cur + v0;
        ok = !w.is_empty & found & is_u64(cur) & is_u64(v0) & is_u64(sum);
        new_row = put_field(w.row, a, sum);
    } else if opcode == 4 {
        ok = !w.is_empty & found & is_u64(cur) & is_u64(v0) & ((cur as u64) >= (v0 as u64));
        new_row = put_field(w.row, a, cur - v0);
    } else if opcode == 5 {
        ok = !w.is_empty;
        new_empty = true;
    }

    let next_leaf = if new_empty { 0 } else { hash_leaf(new_table, new_row) };
    let next_root = compute_root(next_leaf, if is_noop { 0 } else { row_id }, w.siblings);
    if is_noop {
        (root, true)
    } else if ok {
        (next_root, true)
    } else {
        (root, false)
    }
}

global TWO_POW_64: Field = 18446744073709551616;

fn empty_w() -> OpWitness {
    OpWitness { is_empty: true, table_id: 0, row: [0; 6], siblings: zero_siblings() }
}

fn occupied(table_id: Field, row: [Field; 6]) -> (Field, OpWitness) {
    let root = compute_root(hash_leaf(table_id, row), 0, zero_siblings());
    (root, OpWitness { is_empty: false, table_id, row, siblings: zero_siblings() })
}

#[test]
fn insert_into_empty_slot() {
    let (r, ok) = apply_op(empty_root(), [1, 0, 2, 7, 8, 0, 0, 0, 0], empty_w());
    assert(ok);
    assert(r == compute_root(hash_leaf(2, [7, 8, 0, 0, 0, 0]), 0, zero_siblings()));
}

#[test]
fn insert_into_occupied_slot_fails() {
    let (root, w) = occupied(2, [1, 0, 0, 0, 0, 0]);
    let (r, ok) = apply_op(root, [1, 0, 2, 7, 8, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test]
fn add_and_sub_succeed() {
    let (root, w) = occupied(2, [10, 0, 0, 0, 0, 0]);
    let (r1, ok1) = apply_op(root, [3, 0, 0, 5, 0, 0, 0, 0, 0], w);
    assert(ok1);
    assert(r1 == compute_root(hash_leaf(2, [15, 0, 0, 0, 0, 0]), 0, zero_siblings()));
    let (r2, ok2) = apply_op(root, [4, 0, 0, 10, 0, 0, 0, 0, 0], w);
    assert(ok2);
    assert(r2 == compute_root(hash_leaf(2, [0, 0, 0, 0, 0, 0]), 0, zero_siblings()));
}

#[test]
fn add_overflow_fails() {
    let (root, w) = occupied(2, [TWO_POW_64 - 1, 0, 0, 0, 0, 0]);
    let (r, ok) = apply_op(root, [3, 0, 0, 1, 0, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test]
fn add_on_non_u64_field_fails() {
    let (root, w) = occupied(2, [TWO_POW_64, 0, 0, 0, 0, 0]);
    let (r, ok) = apply_op(root, [3, 0, 0, 1, 0, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test]
fn sub_underflow_fails() {
    let (root, w) = occupied(2, [3, 0, 0, 0, 0, 0]);
    let (r, ok) = apply_op(root, [4, 0, 0, 4, 0, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test]
fn set_replaces_field() {
    let (root, w) = occupied(2, [1, 2, 3, 4, 5, 6]);
    let (r, ok) = apply_op(root, [2, 0, 5, 99, 0, 0, 0, 0, 0], w);
    assert(ok);
    assert(r == compute_root(hash_leaf(2, [1, 2, 3, 4, 5, 99]), 0, zero_siblings()));
}

#[test]
fn set_bad_index_fails() {
    let (root, w) = occupied(2, [1, 2, 3, 4, 5, 6]);
    let (r, ok) = apply_op(root, [2, 0, 6, 99, 0, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test]
fn set_on_empty_fails() {
    let (r, ok) = apply_op(empty_root(), [2, 0, 0, 1, 0, 0, 0, 0, 0], empty_w());
    assert(!ok);
    assert(r == empty_root());
}

#[test]
fn delete_restores_empty_root() {
    let (root, w) = occupied(2, [1, 2, 3, 4, 5, 6]);
    let (r, ok) = apply_op(root, [5, 0, 0, 0, 0, 0, 0, 0, 0], w);
    assert(ok);
    assert(r == empty_root());
}

#[test]
fn noop_ignores_garbage_witness() {
    let garbage = OpWitness { is_empty: false, table_id: 42, row: [1; 6], siblings: [7; 20] };
    let (r, ok) = apply_op(empty_root(), [0; 9], garbage);
    assert(ok);
    assert(r == empty_root());
}

#[test]
fn unknown_opcode_fails() {
    let (root, w) = occupied(2, [1, 2, 3, 4, 5, 6]);
    let (r, ok) = apply_op(root, [6, 0, 0, 0, 0, 0, 0, 0, 0], w);
    assert(!ok);
    assert(r == root);
}

#[test(should_fail_with = "witness path does not match root")]
fn lying_witness_rejected() {
    let (root, _) = occupied(2, [1, 2, 3, 4, 5, 6]);
    let _ = apply_op(root, [2, 0, 0, 1, 0, 0, 0, 0, 0], empty_w());
}
