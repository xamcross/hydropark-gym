package io.hydropark.certification;

/**
 * One certification finding. {@code pointer} is a JSON-pointer path into the manifest (e.g.
 * {@code /ui/panels/1/binds_tool}); {@code code} is a stable machine code the pipeline/UI can branch
 * on.
 */
public record Finding(Severity severity, String code, String message, String pointer) {

  public static Finding error(String code, String message, String pointer) {
    return new Finding(Severity.ERROR, code, message, pointer);
  }

  public static Finding warning(String code, String message, String pointer) {
    return new Finding(Severity.WARNING, code, message, pointer);
  }
}
