package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Pure unit tests for the {@link EntitlementService} derivation (P1-15.1) - no Spring context, no
 * Mongo, no Docker. The {@link GrantRepository} is stubbed to feed in-memory {@link Grant} lists
 * with mixed active/terminal states, and we assert the two rules the client depends on:
 *
 * <ul>
 *   <li><b>owned vs revoked-vs-never-owned</b> - a skill is {@code owned} while &ge;1 grant is
 *       active; once fully unowned we surface the <em>most-recent terminal</em> status so the client
 *       tells a revocation apart from a skill it never bought (which is simply <em>absent</em>).
 *   <li><b>the tied-flip rule (B1)</b> - a skill stays {@code owned} while another active grant
 *       survives, even after a sibling grant is refunded/charged_back.
 * </ul>
 *
 * <p>Not run as part of this change (AGENT-CONTRACT: "Do not run mvn").
 */
class EntitlementServiceTest {

  private static final String USER = "user-1";
  private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

  private GrantRepository grants;
  private EntitlementService service;

  @BeforeEach
  void setUp() {
    grants = mock(GrantRepository.class);
    service = new EntitlementService(grants);
  }

  /** An in-memory grant. Only the four getters the derivation reads are stubbed (leniently). */
  private static Grant grant(String skillId, GrantStatus status, Instant grantedAt, Instant revokedAt) {
    Grant g = mock(Grant.class);
    lenient().when(g.getSkillId()).thenReturn(skillId);
    lenient().when(g.getStatus()).thenReturn(status.wire());
    lenient().when(g.getGrantedAt()).thenReturn(grantedAt);
    lenient().when(g.getRevokedAt()).thenReturn(revokedAt);
    return g;
  }

  private static Grant active(String skillId, Instant grantedAt) {
    return grant(skillId, GrantStatus.ACTIVE, grantedAt, null);
  }

  private static Grant terminal(String skillId, GrantStatus status, Instant revokedAt) {
    return grant(skillId, status, T0, revokedAt);
  }

  private List<EntitlementView> forUser(List<Grant> all) {
    when(grants.findByUserId(USER)).thenReturn(all);
    return service.forUser(USER);
  }

  @Test
  void ownedWhenAtLeastOneActiveGrant() {
    assertThat(forUser(List.of(active("cooking", T0))))
        .extracting(EntitlementView::skillId, EntitlementView::status)
        .containsExactly(tuple("cooking", EntitlementView.OWNED));
  }

  @Test
  void skillStaysOwnedWhileAnotherActiveGrantSurvivesARefund() {
    // B1 / tied-flip at the derivation layer: same skill bought two ways (e.g. standalone + bundle);
    // the standalone grant is refunded, the bundle grant is still active -> still owned.
    List<Grant> mixed =
        List.of(
            terminal("cooking", GrantStatus.REFUNDED, T0.plusSeconds(60)),
            active("cooking", T0));

    assertThat(forUser(mixed))
        .extracting(EntitlementView::skillId, EntitlementView::status)
        .containsExactly(tuple("cooking", EntitlementView.OWNED));
  }

  @Test
  void mostRecentTerminalStatusWinsWhenNoActiveGrantRemains() {
    // No active grant. The client must distinguish "revoked" from "refunded"/"charged_back": the
    // most-recent terminal state (by revoked_at) is what surfaces.
    List<Grant> terminals =
        List.of(
            terminal("cooking", GrantStatus.CHARGED_BACK, T0.plusSeconds(10)),
            terminal("cooking", GrantStatus.REFUNDED, T0.plusSeconds(20)),
            terminal("cooking", GrantStatus.REVOKED, T0.plusSeconds(30)));

    assertThat(forUser(terminals))
        .extracting(EntitlementView::skillId, EntitlementView::status)
        .containsExactly(tuple("cooking", GrantStatus.REVOKED.wire()));
  }

  @Test
  void terminalRecencyUsesRevokedAtNotGrantedAt() {
    // gLate is granted later but revoked earlier; gEarly is granted first but revoked last. Recency
    // is by revoked_at, so the older-granted-but-latest-revoked grant's status wins.
    Grant gLate = grant("cooking", GrantStatus.CHARGED_BACK, T0.plusSeconds(50), T0.plusSeconds(60));
    Grant gEarly = grant("cooking", GrantStatus.REFUNDED, T0, T0.plusSeconds(90));

    assertThat(forUser(List.of(gLate, gEarly)))
        .extracting(EntitlementView::status)
        .containsExactly(GrantStatus.REFUNDED.wire());
  }

  @Test
  void neverOwnedSkillIsAbsentEntirely() {
    // "never owned" is not a status - it is the absence of any grant. Only skills the user has ever
    // held appear; a skill with no grant simply never shows up.
    List<EntitlementView> views = forUser(List.of(active("cooking", T0)));

    assertThat(views).extracting(EntitlementView::skillId).containsExactly("cooking");
    assertThat(views).extracting(EntitlementView::skillId).doesNotContain("cleaning");
  }

  @Test
  void distinctSkillsAreDerivedIndependently() {
    List<Grant> all =
        List.of(
            active("cooking", T0),
            terminal("cleaning", GrantStatus.REFUNDED, T0.plusSeconds(5)),
            terminal("budgeting", GrantStatus.REVOKED, T0.plusSeconds(5)));

    assertThat(forUser(all))
        .extracting(EntitlementView::skillId, EntitlementView::status)
        .containsExactlyInAnyOrder(
            tuple("cooking", EntitlementView.OWNED),
            tuple("cleaning", GrantStatus.REFUNDED.wire()),
            tuple("budgeting", GrantStatus.REVOKED.wire()));
  }

  @Test
  void userWithNoGrantsHasNoEntitlements() {
    assertThat(forUser(List.of())).isEmpty();
  }
}
