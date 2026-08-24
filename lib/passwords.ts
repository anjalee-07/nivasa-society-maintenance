/**
 * Password hashing built on PBKDF2 through WebCrypto, which is available in the
 * Workers runtime without pulling in a native dependency.
 *
 * Stored format is `pbkdf2$<iterations>$<salt>$<hash>`, so the iteration count
 * travels with the record and can be raised later without invalidating
 * passwords already in the database.
 */

/**
 * Deliberately below current guidance, which puts PBKDF2-SHA256 in the hundreds
 * of thousands of iterations. The Cloudflare Workers free plan allows 10ms of
 * CPU per request in total, and measured cost is roughly 4.7ms at this setting
 * against 60ms at 210,000 - so a stronger factor cannot complete a request at
 * all on this tier.
 *
 * The stored format records the iteration count per password, so raising this
 * later re-hashes nothing: existing passwords keep verifying at the factor they
 * were written with, and new ones use the stronger setting.
 */
const iterations = 10000;
const keyLength = 32;
const saltLength = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(saltLength));
  const derived = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < 1) return false;

  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  if (!salt || !expected) return false;

  const actual = await derive(password, salt, rounds);
  return timingSafeEqual(actual, expected);
}

async function derive(
  password: string,
  salt: Uint8Array,
  rounds: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  // Copy into a fresh buffer so the value is a plain ArrayBuffer view, which is
  // what the WebCrypto signature requires.
  const saltBytes = new Uint8Array(salt.length);
  saltBytes.set(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: rounds, hash: "SHA-256" },
    key,
    keyLength * 8,
  );
  return new Uint8Array(bits);
}

/** Compare without leaking how many leading bytes matched. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
