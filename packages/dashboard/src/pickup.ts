import { sha256, type Hex } from 'viem';

/**
 * A claim is made out to a pickup hash. The member's device makes a random 32-byte code, keeps it, and puts only its
 * hash into the proof. At the desk the member shows the code. Same function as PointsGate.pickupHash: SHA-256 cut to
 * 248 bits, so it fits a field element.
 */
export const pickupHash = (code: Hex): bigint => BigInt(sha256(code)) >> 8n;

const randomHex = (bytes: number): Hex => `0x${Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const newPickupCode = (): Hex => randomHex(32);

/** A card secret: 31 random bytes, so it is always inside the proof system's field. */
export const newCardSecret = (): bigint => BigInt(randomHex(31));
