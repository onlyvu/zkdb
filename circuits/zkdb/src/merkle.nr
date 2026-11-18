use crate::hash::hash2;

pub global DEPTH: u32 = 20;

/// Recompute the root from a leaf and its authentication path. Fails if index >= 2^DEPTH.
pub fn compute_root(leaf: Field, index: Field, siblings: [Field; DEPTH]) -> Field {
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        node = if bits[i] { hash2(siblings[i], node) } else { hash2(node, siblings[i]) };
    }
    node
}

/// Siblings of any leaf in the empty tree: zero hash of each level.
pub fn zero_siblings() -> [Field; DEPTH] {
    let mut z = [0; DEPTH];
    for i in 1..DEPTH {
        z[i] = hash2(z[i - 1], z[i - 1]);
    }
    z
}

pub fn empty_root() -> Field {
    let mut z = 0;
    for _ in 0..DEPTH {
        z = hash2(z, z);
    }
    z
}

#[test]
fn empty_root_matches_ts() {
    assert(empty_root() == crate::test_vectors::EMPTY_ROOT);
}

#[test]
fn path_root_matches_ts() {
    let root = compute_root(crate::test_vectors::LEAF_2_123456, 5, crate::test_vectors::SIBLINGS_ROW5);
    assert(root == crate::test_vectors::ROOT_TWO_ROWS);
}

#[test(should_fail)]
fn index_out_of_range_fails() {
    let _ = compute_root(1, 1048576, [0; DEPTH]);
}
