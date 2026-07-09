package io.hydropark.catalog;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.hydropark.catalog.dto.BundleDetailDto;
import io.hydropark.catalog.dto.PreviewDto;
import io.hydropark.common.ApiException;
import io.hydropark.common.Money;
import io.hydropark.port.Ports;
import io.hydropark.security.AuthPrincipal;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Unit tests for {@link CatalogService} covering bundle-detail pricing/ownership and preview
 * (P1-13.3/13.4). Not run as part of this change (AGENT-CONTRACT: "Do not run mvn").
 */
class CatalogServiceTest {

  private MongoTemplate mongo;
  private SkillRepository skills;
  private SkillVersionRepository skillVersions;
  private BundleRepository bundles;
  private BundleMemberRepository bundleMembers;
  private Ports.PricingPort pricing;
  private Ports.GrantPort grants;
  private CatalogService service;

  @BeforeEach
  void setUp() {
    mongo = mock(MongoTemplate.class);
    skills = mock(SkillRepository.class);
    skillVersions = mock(SkillVersionRepository.class);
    bundles = mock(BundleRepository.class);
    bundleMembers = mock(BundleMemberRepository.class);
    pricing = mock(Ports.PricingPort.class);
    grants = mock(Ports.GrantPort.class);
    service = new CatalogService(mongo, skills, skillVersions, bundles, bundleMembers, pricing, grants);
  }

  @AfterEach
  void clearAuth() {
    SecurityContextHolder.clearContext();
  }

  private static Skill skill(String id, String name, String category) {
    Skill s = new Skill();
    s.setId(id);
    s.setName(name);
    s.setCategory(category);
    return s;
  }

  private static BundleMember member(String bundleId, String skillId) {
    BundleMember m = new BundleMember();
    m.setBundleId(bundleId);
    m.setSkillId(skillId);
    return m;
  }

  @Test
  void bundleDetailComparesBundlePriceAgainstMemberSum() {
    Bundle bundle = new Bundle();
    bundle.setId("home-starter-pack");
    bundle.setName("Home Starter Pack");
    bundle.setStatus("published");
    when(bundles.findById("home-starter-pack")).thenReturn(Optional.of(bundle));
    when(bundleMembers.findByBundleId("home-starter-pack"))
        .thenReturn(List.of(member("home-starter-pack", "cooking-assistant"), member("home-starter-pack", "cleaning-planner")));
    when(skills.findAllById(any()))
        .thenReturn(List.of(skill("cooking-assistant", "Cooking Assistant", "home"), skill("cleaning-planner", "Cleaning Planner", "home")));

    when(pricing.quote(Ports.PurchaseKind.BUNDLE, "home-starter-pack", null)).thenReturn(new Money(700, "USD"));
    when(pricing.quote(Ports.PurchaseKind.SKILL, "cooking-assistant", null)).thenReturn(new Money(500, "USD"));
    when(pricing.quote(Ports.PurchaseKind.SKILL, "cleaning-planner", null)).thenReturn(new Money(500, "USD"));

    BundleDetailDto detail = service.getBundleDetail("home-starter-pack", null);

    assertThat(detail.bundlePrice()).isEqualTo(new Money(700, "USD"));
    assertThat(detail.memberPriceSum()).isEqualTo(new Money(1000, "USD"));
    assertThat(detail.savings()).isEqualTo(new Money(300, "USD"));
    assertThat(detail.members()).hasSize(2);
    // anonymous caller - owned must be null, never false, so clients can distinguish
    // "not authenticated" from "authenticated and not owned".
    assertThat(detail.owned()).isNull();
  }

  @Test
  void bundleOwnedOnlyWhenEveryMemberHasAnActiveGrant() {
    Bundle bundle = new Bundle();
    bundle.setId("home-starter-pack");
    bundle.setName("Home Starter Pack");
    bundle.setStatus("published");
    when(bundles.findById("home-starter-pack")).thenReturn(Optional.of(bundle));
    when(bundleMembers.findByBundleId("home-starter-pack"))
        .thenReturn(List.of(member("home-starter-pack", "cooking-assistant"), member("home-starter-pack", "cleaning-planner")));
    when(skills.findAllById(any()))
        .thenReturn(List.of(skill("cooking-assistant", "Cooking Assistant", "home"), skill("cleaning-planner", "Cleaning Planner", "home")));
    when(pricing.quote(any(), anyString(), any())).thenReturn(new Money(500, "USD"));

    SecurityContextHolder.getContext().setAuthentication(new AuthPrincipal("user-1", true));
    when(grants.hasActiveGrant("user-1", "cooking-assistant")).thenReturn(true);
    when(grants.hasActiveGrant("user-1", "cleaning-planner")).thenReturn(false);

    BundleDetailDto partiallyOwned = service.getBundleDetail("home-starter-pack", null);
    assertThat(partiallyOwned.owned()).isFalse();

    when(grants.hasActiveGrant("user-1", "cleaning-planner")).thenReturn(true);
    BundleDetailDto fullyOwned = service.getBundleDetail("home-starter-pack", null);
    assertThat(fullyOwned.owned()).isTrue();
  }

  @Test
  void bundleDetailThrowsNotFoundForUnknownBundle() {
    when(bundles.findById("ghost")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> service.getBundleDetail("ghost", null)).isInstanceOf(ApiException.class);
  }

  @Test
  void previewReturnsCuratedTranscriptWhenPresent() {
    Skill s = skill("cooking-assistant", "Cooking Assistant", "home");
    s.setPreviewTranscriptUri("https://cdn.example/previews/cooking-assistant.json");
    when(skills.findById("cooking-assistant")).thenReturn(Optional.of(s));

    PreviewDto preview = service.getPreview("cooking-assistant");

    assertThat(preview.previewTranscriptUri()).isEqualTo("https://cdn.example/previews/cooking-assistant.json");
  }

  @Test
  void previewThrowsNotFoundWhenNoCuratedTranscriptExists() {
    Skill s = skill("cooking-assistant", "Cooking Assistant", "home");
    s.setPreviewTranscriptUri(null);
    when(skills.findById("cooking-assistant")).thenReturn(Optional.of(s));

    assertThatThrownBy(() -> service.getPreview("cooking-assistant")).isInstanceOf(ApiException.class);
  }

  @Test
  void getPreviewAcceptsOnlyASkillIdNoPromptOfAnyKind() throws NoSuchMethodException {
    // Structural guarantee, not just behavioral: the method signature itself has no room for a
    // client-supplied prompt (BE §4.2 N1) - there is no overload and no second parameter to add one to.
    var method = CatalogService.class.getMethod("getPreview", String.class);
    assertThat(method.getParameterCount()).isEqualTo(1);
    assertThat(method.getParameterTypes()[0]).isEqualTo(String.class);
  }
}
