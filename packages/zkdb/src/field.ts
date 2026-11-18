export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function toBuf32(x: bigint): Uint8Array {
  if (x < 0n || x >= P) throw new Error(`value out of field range: ${x}`);
  const b = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

export function fromBuf(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

export const toHex = (x: bigint): string => '0x' + x.toString(16).padStart(64, '0');
