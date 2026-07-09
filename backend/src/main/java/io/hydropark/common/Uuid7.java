package io.hydropark.common;

import java.security.SecureRandom;
import java.util.UUID;

/**
 * UUIDv7 (RFC 9562) - time-ordered identifiers.
 *
 * <p>BACKEND-DESIGN §11 requires one id scheme project-wide. We use UUIDv7 strings rather than
 * ObjectId so ids stay portable across the reference relational model and MongoDB, and so they
 * can be embedded verbatim in signed license payloads.
 */
public final class Uuid7 {

  private static final SecureRandom RANDOM = new SecureRandom();

  private Uuid7() {}

  public static String generate() {
    return generateUuid().toString();
  }

  public static UUID generateUuid() {
    long millis = System.currentTimeMillis();
    byte[] rand = new byte[10];
    RANDOM.nextBytes(rand);

    // 48 bits unix_ts_ms | 4 bits version (7) | 12 bits rand_a
    long msb = (millis & 0xFFFFFFFFFFFFL) << 16;
    msb |= 0x7000L; // version 7
    msb |= ((rand[0] & 0x0FL) << 8) | (rand[1] & 0xFFL);

    // 2 bits variant (10) | 62 bits rand_b
    long lsb = 0L;
    for (int i = 2; i < 10; i++) {
      lsb = (lsb << 8) | (rand[i] & 0xFFL);
    }
    lsb &= 0x3FFFFFFFFFFFFFFFL;
    lsb |= 0x8000000000000000L; // variant 10

    return new UUID(msb, lsb);
  }

  /** Prefixed id for human-legible logs, e.g. {@code lic_018f...}. */
  public static String prefixed(String prefix) {
    return prefix + "_" + generate().replace("-", "");
  }
}
