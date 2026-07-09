package io.hydropark.catalog;

import io.hydropark.common.ApiException;

/**
 * Shared status vocabulary for {@code skills}, {@code skill_versions} and {@code bundles} (BE
 * §3.2): {@code published | deprecated | withdrawn}.
 *
 * <p>Entities store the raw wire string in a plain {@code String} field (never a Java enum type
 * bound directly to the document) - this package cannot register a custom Mongo enum converter
 * without touching {@code io.hydropark.config}, which is off-limits (AGENT-CONTRACT). This enum
 * exists purely as an in-code vocabulary/validation helper, mirroring the {@code .wire()} pattern
 * already used by {@link io.hydropark.port.Ports}'s enums.
 */
public enum CatalogStatus {
  PUBLISHED("published"),
  DEPRECATED("deprecated"),
  WITHDRAWN("withdrawn");

  private final String wire;

  CatalogStatus(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }

  public static CatalogStatus fromWire(String s) {
    for (CatalogStatus v : values()) {
      if (v.wire.equals(s)) {
        return v;
      }
    }
    throw ApiException.validation("unknown catalog status: " + s);
  }
}
