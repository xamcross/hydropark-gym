package io.hydropark.certification;

/** Finding severity. Only {@link #ERROR} blocks certification; warnings/info are advisory. */
public enum Severity {
  ERROR,
  WARNING,
  INFO
}
