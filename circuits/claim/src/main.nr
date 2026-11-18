use poseidon::poseidon2::Poseidon2;
use zkdb::hash::hash_leaf;
use zkdb::merkle::{compute_root, DEPTH};

// A member row of a points table: [card number, balance, card key, 0, 0, 0].
global BALANCE: u32 = 1;
global CARD_KEY: u32 = 2;

/// What a row stores about its card: a hash of the secret printed on the card.
pub fn card_key(secret: Field) -> Field {
    Poseidon2::hash([secret], 1)
}

/// One per card and perk. It does not reveal the card: computing it needs the secret.
pub fn nullifier_of(secret: Field, perk_id: Field) -> Field {
    Poseidon2::hash([secret, perk_id], 2)
}

fn is_u64(x: Field) -> bool {
    (x as u64) as Field == x
}

/// "Some card in this root has at least min_points, I hold its secret, and this is its nullifier for this perk."
/// The row, its position and the secret stay private.
///
/// `pickup` names who the claim is for: the hash of a one-time pickup code the member's device makes up. It is a
/// public input, so the proof is only valid together with it. Someone who copies the proof and sends it first can
/// only record the claim under the member's own pickup hash.
fn main(
    root: pub Field,
    table_id: pub Field,
    min_points: pub Field,
    perk_id: pub Field,
    nullifier: pub Field,
    pickup: pub Field,
    row_id: Field,
    row: [Field; 6],
    siblings: [Field; DEPTH],
    secret: Field,
) {
    assert(compute_root(hash_leaf(table_id, row), row_id, siblings) == root, "card is not in this root");
    assert(row[CARD_KEY] == card_key(secret), "wrong card secret");
    assert(is_u64(row[BALANCE]) & is_u64(min_points), "balance out of range");
    assert(row[BALANCE] as u64 >= min_points as u64, "not enough points");
    assert(nullifier == nullifier_of(secret, perk_id), "wrong nullifier");
    assert(pickup != 0, "a claim needs a pickup hash");
}

global SECRET: Field = 0x1234;
global TABLE: Field = 1;
global PICKUP: Field = 0x7069636b7570;

fn member(points: Field) -> ([Field; 6], Field) {
    let row = [42, points, card_key(SECRET), 0, 0, 0];
    let root = compute_root(hash_leaf(TABLE, row), 7, zkdb::merkle::zero_siblings());
    (row, root)
}

#[test]
fn enough_points_claims() {
    let (row, root) = member(1250);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test]
fn exactly_the_threshold_claims() {
    let (row, root) = member(500);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "not enough points")]
fn too_few_points_fails() {
    let (row, root) = member(250);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "wrong card secret")]
fn someone_elses_card_fails() {
    let (row, root) = member(1250);
    main(root, TABLE, 500, 1, nullifier_of(0x9999, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), 0x9999);
}

#[test(should_fail_with = "card is not in this root")]
fn invented_balance_fails() {
    let (_, root) = member(250);
    let forged = [42, 1250, card_key(SECRET), 0, 0, 0];
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, forged, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "card is not in this root")]
fn row_of_another_table_fails() {
    let (row, root) = member(1250);
    main(root, 2, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "wrong nullifier")]
fn nullifier_of_another_perk_fails() {
    let (row, root) = member(1250);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 2), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "balance out of range")]
fn balance_above_u64_fails() {
    // SET can store any field element; the comparison must not wrap around.
    let (row, root) = member(18446744073709551616 + 600);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), PICKUP, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}

#[test(should_fail_with = "a claim needs a pickup hash")]
fn claim_without_a_pickup_hash_fails() {
    let (row, root) = member(1250);
    main(root, TABLE, 500, 1, nullifier_of(SECRET, 1), 0, 7, row, zkdb::merkle::zero_siblings(), SECRET);
}
