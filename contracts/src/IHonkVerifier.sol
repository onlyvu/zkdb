// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// Interface of the bb-generated UltraHonk Solidity verifier.
interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
