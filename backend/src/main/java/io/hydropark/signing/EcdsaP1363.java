package io.hydropark.signing;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

/**
 * Converts an ECDSA signature between the JDK's <b>ASN.1/DER</b> encoding and the fixed-width <b>raw
 * {@code R || S}</b> encoding that JWS ES256 requires (IEEE P1363 / JWA RFC 7518 §3.4).
 *
 * <p><b>Why this class exists — the single most common ES256 defect.</b> Java's {@code
 * Signature.getInstance("SHA256withECDSA")} both produces and consumes a <em>DER-encoded</em>
 * signature: a {@code SEQUENCE { INTEGER r, INTEGER s }} of variable length (~70–72 bytes). JWS ES256
 * instead mandates the fixed <b>64-byte</b> concatenation of {@code R} and {@code S}, each left-zero-
 * padded to 32 bytes for P-256. A Java-signs-then-Java-verifies round trip passes even if DER is
 * (wrongly) left on both sides, so the bug hides — the only way to catch it is to actually emit the
 * P1363 form on the wire (and cross-verify with WebCrypto, which expects R||S). Hence:
 *
 * <ul>
 *   <li><b>On sign</b> ({@link #derToConcat}): parse the DER {@code SEQUENCE}, take the two INTEGER
 *       magnitudes, strip DER sign/leading-zero bytes, left-pad each to {@code intLen} bytes, and
 *       concatenate → {@code 2 * intLen} bytes. Base64url that as the JWS signature segment.
 *   <li><b>On verify</b> ({@link #concatToDer}): split the received {@code R||S} in half, re-encode
 *       each half as a minimal ASN.1 INTEGER (adding a {@code 0x00} sign byte when the high bit is
 *       set), wrap in a {@code SEQUENCE}, and hand that DER to {@code Signature.verify()}.
 * </ul>
 *
 * <p>For P-256, {@code intLen} is 32 and the concatenation is exactly 64 bytes. This class does no
 * crypto — it is pure byte reshaping — so it lives in the signer-neutral {@code signing} package and
 * is used by both {@link Es256Signer} (sign side) and {@code io.hydropark.licensing.LicenseVerifier}
 * (verify side).
 */
public final class EcdsaP1363 {

  private EcdsaP1363() {}

  /** P-256: each of R and S is a 32-byte big-endian integer; the raw signature is 64 bytes. */
  public static final int P256_COORD_BYTES = 32;

  /**
   * DER {@code SEQUENCE { INTEGER r, INTEGER s }} → raw {@code R || S} of exactly {@code 2 * intLen}
   * bytes (each coordinate left-zero-padded big-endian). Used on the sign side to turn the JDK's DER
   * output into the JWS ES256 wire form.
   *
   * @throws IllegalArgumentException if {@code der} is not a well-formed two-INTEGER SEQUENCE or a
   *     coordinate does not fit in {@code intLen} bytes.
   */
  public static byte[] derToConcat(byte[] der, int intLen) {
    if (der == null) {
      throw new IllegalArgumentException("null DER signature");
    }
    Cursor c = new Cursor(der);
    c.expect(0x30, "SEQUENCE");
    int seqLen = c.readLength();
    int end = c.pos + seqLen;
    if (end > der.length) {
      throw new IllegalArgumentException("ECDSA DER: SEQUENCE length overruns buffer");
    }
    byte[] r = c.readInteger();
    byte[] s = c.readInteger();
    if (c.pos != end) {
      throw new IllegalArgumentException("ECDSA DER: trailing bytes after R,S");
    }

    byte[] out = new byte[intLen * 2];
    writeFixed(r, out, 0, intLen);
    writeFixed(s, out, intLen, intLen);
    return out;
  }

  /**
   * Raw {@code R || S} → DER {@code SEQUENCE { INTEGER r, INTEGER s }}. Used on the verify side to
   * turn a received JWS ES256 signature back into the DER the JDK's {@code Signature.verify()}
   * expects. The input length must be even; each half is treated as an unsigned big-endian magnitude.
   */
  public static byte[] concatToDer(byte[] concat) {
    if (concat == null || concat.length == 0 || (concat.length & 1) != 0) {
      throw new IllegalArgumentException(
          "raw ECDSA signature must be a non-empty even length (R||S); got "
              + (concat == null ? "null" : concat.length));
    }
    int n = concat.length / 2;
    byte[] rInt = toDerInteger(Arrays.copyOfRange(concat, 0, n));
    byte[] sInt = toDerInteger(Arrays.copyOfRange(concat, n, concat.length));

    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(0x30);
    writeLength(out, rInt.length + sInt.length);
    out.write(rInt, 0, rInt.length);
    out.write(sInt, 0, sInt.length);
    return out.toByteArray();
  }

  // ---------------------------------------------------------------------------------------------
  // A minimal single-pass DER reader. A P-256 signature is always short-form (< 128 bytes), but
  // one-byte long-form lengths are handled defensively so a slightly larger curve would not silently
  // corrupt. No third-party ASN.1 dependency, deliberately: the grammar here is exactly two INTEGERs.
  // ---------------------------------------------------------------------------------------------

  private static final class Cursor {
    final byte[] b;
    int pos;

    Cursor(byte[] b) {
      this.b = b;
    }

    int next() {
      if (pos >= b.length) {
        throw new IllegalArgumentException("ECDSA DER: unexpected end of buffer");
      }
      return b[pos++] & 0xff;
    }

    void expect(int tag, String what) {
      if (next() != tag) {
        throw new IllegalArgumentException("ECDSA DER: expected " + what);
      }
    }

    int readLength() {
      int first = next();
      if (first < 0x80) {
        return first;
      }
      int numBytes = first & 0x7f;
      if (numBytes == 0 || numBytes > 4) {
        throw new IllegalArgumentException("ECDSA DER: unsupported length form");
      }
      int len = 0;
      for (int k = 0; k < numBytes; k++) {
        len = (len << 8) | next();
      }
      return len;
    }

    byte[] readInteger() {
      expect(0x02, "INTEGER");
      int len = readLength();
      if (len <= 0 || pos + len > b.length) {
        throw new IllegalArgumentException("ECDSA DER: bad INTEGER length");
      }
      byte[] v = Arrays.copyOfRange(b, pos, pos + len);
      pos += len;
      return v;
    }
  }

  /** Left-pad an unsigned big-endian magnitude into {@code out[off .. off+len)}, stripping leading zeros. */
  private static void writeFixed(byte[] mag, byte[] out, int off, int len) {
    int start = 0;
    while (start < mag.length && mag[start] == 0) {
      start++;
    }
    int vlen = mag.length - start;
    if (vlen > len) {
      throw new IllegalArgumentException("ECDSA coordinate exceeds " + len + " bytes");
    }
    System.arraycopy(mag, start, out, off + (len - vlen), vlen);
  }

  /** Encode an unsigned big-endian magnitude as a minimal DER INTEGER (0x02 len [0x00] value). */
  private static byte[] toDerInteger(byte[] mag) {
    int start = 0;
    while (start < mag.length - 1 && mag[start] == 0) {
      start++;
    }
    byte[] v = Arrays.copyOfRange(mag, start, mag.length);
    boolean needsSignByte = (v[0] & 0x80) != 0; // high bit set → prepend 0x00 to stay positive
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(0x02);
    writeLength(out, v.length + (needsSignByte ? 1 : 0));
    if (needsSignByte) {
      out.write(0x00);
    }
    out.write(v, 0, v.length);
    return out.toByteArray();
  }

  private static void writeLength(ByteArrayOutputStream out, int len) {
    if (len < 0x80) {
      out.write(len);
    } else if (len < 0x100) {
      out.write(0x81);
      out.write(len);
    } else {
      out.write(0x82);
      out.write((len >> 8) & 0xff);
      out.write(len & 0xff);
    }
  }
}
