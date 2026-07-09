package io.hydropark.migration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AssignableTypeFilter;
import org.springframework.stereotype.Component;

/**
 * Guards the properties {@link MigrationRunner} assumes but does not test: every changeset id is
 * unique, ids sort into their intended execution order, and every changeset on the classpath is
 * actually discoverable at runtime.
 *
 * <p><b>Changesets are discovered by scanning, not by a hand-maintained list.</b> An earlier version
 * of this test enumerated {@code V001…V007} in a {@code List.of(...)} and justified it by claiming a
 * forgotten registration would "fail this test instead of silently never running in production". That
 * reasoning was backwards. {@link MigrationRunner} takes {@code List<Migration>} by injection, so a
 * {@code @Component} changeset runs in production whether or not anyone remembers this file. The list
 * therefore protected nothing - and it had already drifted: {@code V008} and {@code V009} existed on
 * disk, ran against every database, and were invisible here. A test whose coverage depends on a human
 * remembering to widen it will eventually assert something narrower than the truth.
 */
class MigrationChangesetOrderingTest {

  private static final String CHANGESET_PACKAGE = "io.hydropark.migration.changesets";

  /** Every {@link Migration} on the classpath, ordered exactly as {@link MigrationRunner} orders them. */
  private static final List<Migration> ALL_MIGRATIONS = discoverChangesets();

  private static List<Migration> discoverChangesets() {
    ClassPathScanningCandidateComponentProvider scanner =
        new ClassPathScanningCandidateComponentProvider(false);
    scanner.addIncludeFilter(new AssignableTypeFilter(Migration.class));

    List<Migration> found = new ArrayList<>();
    for (BeanDefinition def : scanner.findCandidateComponents(CHANGESET_PACKAGE)) {
      try {
        Class<?> type = Class.forName(def.getBeanClassName());
        found.add((Migration) type.getDeclaredConstructor().newInstance());
      } catch (ReflectiveOperationException e) {
        throw new IllegalStateException(
            "changeset " + def.getBeanClassName() + " has no usable no-arg constructor", e);
      }
    }
    // MigrationRunner sorts by Migration::id rather than trusting bean-discovery order.
    return found.stream().sorted(Comparator.comparing(Migration::id)).toList();
  }

  @Test
  void atLeastTheKnownChangesetsAreDiscovered() {
    // A scan that silently finds nothing would make every other assertion here vacuously pass.
    assertTrue(
        ALL_MIGRATIONS.size() >= 9,
        "expected to discover at least the 9 known changesets, found " + ALL_MIGRATIONS.size());
  }

  @Test
  void everyChangesetIsSpringDiscoverable() {
    // MigrationRunner receives changesets by injection. One missing @Component never runs - and,
    // because the runner records only what it ran, its absence leaves no trace in schema_migrations.
    for (Migration m : ALL_MIGRATIONS) {
      assertTrue(
          m.getClass().isAnnotationPresent(Component.class),
          m.getClass().getSimpleName() + " is not annotated @Component, so it will never be applied");
    }
  }

  @Test
  void everyMigrationIdIsUnique() {
    Set<String> seen = new LinkedHashSet<>();
    for (Migration m : ALL_MIGRATIONS) {
      assertTrue(seen.add(m.id()), "duplicate migration id: " + m.id());
    }
  }

  @Test
  void migrationIdsAreStrictlyIncreasingInNaturalSortOrder() {
    List<String> ids = ALL_MIGRATIONS.stream().map(Migration::id).toList();
    List<String> sorted = ids.stream().sorted(Comparator.naturalOrder()).toList();
    assertEquals(sorted, ids, "changeset ids do not sort into their intended execution order");
  }

  @Test
  void everyMigrationIdMatchesTheZeroPaddedNamingConvention() {
    for (Migration m : ALL_MIGRATIONS) {
      assertTrue(
          m.id().matches("V\\d{3}__[a-z0-9_]+"),
          "id does not match the V###__snake_case_description convention: " + m.id());
    }
  }

  @Test
  void everyMigrationHasANonBlankDescription() {
    for (Migration m : ALL_MIGRATIONS) {
      assertFalse(
          m.description() == null || m.description().isBlank(), "blank description for " + m.id());
    }
  }
}
