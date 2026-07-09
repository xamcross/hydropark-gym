package io.hydropark.catalog;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.port.Ports;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for catalog's {@link Ports.PricingPort} implementation (P1-13). Repositories are
 * mocked - these exercise the pricing/lookup logic only, not Spring Data query derivation or Mongo
 * itself. Not run as part of this change (AGENT-CONTRACT: "Do not run mvn").
 */
class PricingPortImplTest {

  private SkillRepository skills;
  private BundleRepository bundles;
  private BundleMemberRepository bundleMembers;
  private RegionalPriceRepository regionalPrices;
  private PricingPortImpl pricing;

  @BeforeEach
  void setUp() {
    skills = mock(SkillRepository.class);
    bundles = mock(BundleRepository.class);
    bundleMembers = mock(BundleMemberRepository.class);
    regionalPrices = mock(RegionalPriceRepository.class);
    pricing = new PricingPortImpl(skills, bundles, bundleMembers, regionalPrices);
  }

  private static Skill skill(String id, long basePrice, String currency) {
    Skill s = new Skill();
    s.setId(id);
    s.setBasePrice(basePrice);
    s.setBaseCurrency(currency);
    s.setFree(basePrice == 0);
    return s;
  }

  private static RegionalPrice regionalPrice(
      String targetType, String targetId, String region, long price, String currency) {
    RegionalPrice rp = new RegionalPrice();
    rp.setTargetType(targetType);
    rp.setTargetId(targetId);
    rp.setRegion(region);
    rp.setPrice(price);
    rp.setCurrency(currency);
    return rp;
  }

  @Test
  void regionalPriceOverridesBase() {
    when(skills.findById("cooking-assistant")).thenReturn(Optional.of(skill("cooking-assistant", 500, "USD")));
    when(regionalPrices.findByTargetTypeAndTargetIdAndRegion("skill", "cooking-assistant", "IN"))
        .thenReturn(Optional.of(regionalPrice("skill", "cooking-assistant", "IN", 150, "USD")));

    Money quoted = pricing.quote(Ports.PurchaseKind.SKILL, "cooking-assistant", "IN");

    assertThat(quoted).isEqualTo(new Money(150, "USD"));
  }

  @Test
  void missingRegionalRowFallsBackToBasePrice() {
    when(skills.findById("cooking-assistant")).thenReturn(Optional.of(skill("cooking-assistant", 500, "USD")));
    when(regionalPrices.findByTargetTypeAndTargetIdAndRegion(any(), any(), any()))
        .thenReturn(Optional.empty());

    Money quoted = pricing.quote(Ports.PurchaseKind.SKILL, "cooking-assistant", "ZZ");

    assertThat(quoted).isEqualTo(new Money(500, "USD"));
  }

  @Test
  void nullRegionSkipsRegionalLookupEntirelyAndUsesBase() {
    when(skills.findById("cooking-assistant")).thenReturn(Optional.of(skill("cooking-assistant", 500, "USD")));

    Money quoted = pricing.quote(Ports.PurchaseKind.SKILL, "cooking-assistant", null);

    assertThat(quoted).isEqualTo(new Money(500, "USD"));
    verifyNoInteractions(regionalPrices);
  }

  @Test
  void freeSkillStillResolvesThroughQuote() {
    when(skills.findById("kitchen-timer")).thenReturn(Optional.of(skill("kitchen-timer", 0, "USD")));
    when(regionalPrices.findByTargetTypeAndTargetIdAndRegion(any(), any(), any()))
        .thenReturn(Optional.empty());

    Money quoted = pricing.quote(Ports.PurchaseKind.SKILL, "kitchen-timer", "US");

    assertThat(quoted.amount()).isZero();
    assertThat(quoted.currency()).isEqualTo("USD");
  }

  @Test
  void bundleRegionalPriceOverridesBundlePrice() {
    Bundle bundle = new Bundle();
    bundle.setId("home-starter-pack");
    bundle.setBundlePrice(1000);
    bundle.setBaseCurrency("USD");
    when(bundles.findById("home-starter-pack")).thenReturn(Optional.of(bundle));
    when(regionalPrices.findByTargetTypeAndTargetIdAndRegion("bundle", "home-starter-pack", "IN"))
        .thenReturn(Optional.of(regionalPrice("bundle", "home-starter-pack", "IN", 400, "USD")));

    Money quoted = pricing.quote(Ports.PurchaseKind.BUNDLE, "home-starter-pack", "IN");

    assertThat(quoted).isEqualTo(new Money(400, "USD"));
  }

  @Test
  void memberSkillsOnBundleReturnsEveryMember() {
    BundleMember m1 = new BundleMember();
    m1.setBundleId("home-starter-pack");
    m1.setSkillId("cooking-assistant");
    BundleMember m2 = new BundleMember();
    m2.setBundleId("home-starter-pack");
    m2.setSkillId("cleaning-planner");
    when(bundleMembers.findByBundleId("home-starter-pack")).thenReturn(List.of(m1, m2));

    List<String> members = pricing.memberSkills(Ports.PurchaseKind.BUNDLE, "home-starter-pack");

    assertThat(members).containsExactlyInAnyOrder("cooking-assistant", "cleaning-planner");
  }

  @Test
  void memberSkillsOnSkillReturnsJustItself() {
    List<String> members = pricing.memberSkills(Ports.PurchaseKind.SKILL, "cooking-assistant");

    assertThat(members).containsExactly("cooking-assistant");
    verifyNoInteractions(bundleMembers);
  }

  @Test
  void memberSkillsOnWalletTopupIsEmpty() {
    assertThat(pricing.memberSkills(Ports.PurchaseKind.WALLET_TOPUP, "n/a")).isEmpty();
  }

  @Test
  void assertTargetExistsThrowsNotFoundForMissingSkill() {
    when(skills.existsById("ghost")).thenReturn(false);

    assertThatThrownBy(() -> pricing.assertTargetExists(Ports.PurchaseKind.SKILL, "ghost"))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.NOT_FOUND));
  }

  @Test
  void assertTargetExistsPassesForExistingBundle() {
    when(bundles.existsById("home-starter-pack")).thenReturn(true);

    pricing.assertTargetExists(Ports.PurchaseKind.BUNDLE, "home-starter-pack");
    // no exception
  }

  @Test
  void quoteRejectsWalletTopupSinceClientAmountIsAuthoritative() {
    assertThatThrownBy(() -> pricing.quote(Ports.PurchaseKind.WALLET_TOPUP, "n/a", "US"))
        .isInstanceOf(ApiException.class);
  }
}
