package io.hydropark.auth.support;

import java.util.Locale;

/**
 * Email normalisation. Stored emails are lower-cased and trimmed so a plain equality lookup is
 * case-insensitive and matches the migration's collation-unique index (§3.1/§11.1). A blank value
 * normalises to {@code null} so an empty string is never persisted as an email.
 */
public final class Emails {

  private Emails() {}

  public static String normalize(String email) {
    if (email == null) {
      return null;
    }
    String trimmed = email.trim().toLowerCase(Locale.ROOT);
    return trimmed.isEmpty() ? null : trimmed;
  }
}
