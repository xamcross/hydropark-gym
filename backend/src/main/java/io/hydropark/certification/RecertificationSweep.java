package io.hydropark.certification;

import java.util.ArrayList;
import java.util.List;

/**
 * The outcome of a {@link RecertificationTrigger#sweep} (P1-20.5): the skill versions that were
 * marked as needing re-certification and why. Empty {@link #marked()} means the reference was
 * unchanged for the whole fleet.
 */
public record RecertificationSweep(List<Marked> marked) {

  public RecertificationSweep {
    marked = List.copyOf(marked);
  }

  public int count() {
    return marked.size();
  }

  public boolean isEmpty() {
    return marked.isEmpty();
  }

  /** One marked version and the reason it was flagged. */
  public record Marked(String skillVersionId, RecertificationReason reason) {}

  static final class Builder {
    private final List<Marked> marked = new ArrayList<>();

    void add(String skillVersionId, RecertificationReason reason) {
      marked.add(new Marked(skillVersionId, reason));
    }

    RecertificationSweep build() {
      return new RecertificationSweep(marked);
    }
  }
}
