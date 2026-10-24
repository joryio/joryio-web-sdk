/**
 * The same 32-bit hash the backend uses, kept byte-for-byte identical.
 *
 * MIRRORS packages/backend/src/common/utils/bucket-hash.util.ts. A backend
 * tripwire (sdk-web-hash-parity.spec.ts) fails if the two drift, because a hash
 * that is "nearly" the same is worse than an obviously different one - it
 * agrees on most inputs and disagrees on the ones nobody tested.
 *
 * FNV-1a XORs each byte in before multiplying, so every input bit reaches the
 * whole word. Its last operation is a multiply though, and multiplication only
 * ever carries LEFT - nothing propagates down into the low bits. Anything
 * reading those (a `% n`) sees a biased digest, so MurmurHash3's fmix32
 * finalizer folds the high bits back down.
 *
 * NOT for anything security-bearing. It is a fast non-cryptographic hash.
 */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** MurmurHash3's 32-bit finalizer - see the note above about low bits. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit FNV-1a over the UTF-16 code units, finalized, returned unsigned. */
export function bucketHash(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Both bytes of the code unit, so 'Ā' and 'A' cannot collide by truncation.
    hash ^= code & 0xff;
    hash = Math.imul(hash, FNV_PRIME);
    hash ^= (code >>> 8) & 0xff;
    hash = Math.imul(hash, FNV_PRIME);
  }
  // >>> 0 rather than Math.abs: Math.abs(-2147483648) is not a 32-bit int, and
  // negating loses the top bit's contribution.
  return fmix32(hash >>> 0);
}
