use poseidon::poseidon2::Poseidon2;

pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

pub fn hash_leaf(table_id: Field, row: [Field; 6]) -> Field {
    Poseidon2::hash([table_id, row[0], row[1], row[2], row[3], row[4], row[5]], 7)
}

#[test]
fn hash2_matches_ts() {
    assert(hash2(1, 2) == crate::test_vectors::H2_1_2);
}

#[test]
fn leaf_matches_ts() {
    assert(hash_leaf(2, [1, 2, 3, 4, 5, 6]) == crate::test_vectors::LEAF_2_123456);
}
