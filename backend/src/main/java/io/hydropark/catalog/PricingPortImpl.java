package io.hydropark.catalog;

import io.hydropark.common.ApiException;
import io.hydropark.common.Money;
import io.hydropark.port.Ports;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * {@code catalog}'s implementation of {@link Ports.PricingPort} (BE §3.2, §4.2, §7.2).
 *
 * <p>Consumed by the settlement worker, which is the <b>sole price authority</b> (SF1): a
 * client-supplied amount for a {@code skill}/{@code bundle} purchase never reaches this class or
 * anything downstream of it - the worker calls {@link #quote} itself and derives the amount from
 * {@code (target_id, region)} alone.
 */
@Component
public class PricingPortImpl implements Ports.PricingPort {

  private final SkillRepository skills;
  private final BundleRepository bundles;
  private final BundleMemberRepository bundleMembers;
  private final RegionalPriceRepository regionalPrices;

  public PricingPortImpl(
      SkillRepository skills,
      BundleRepository bundles,
      BundleMemberRepository bundleMembers,
      RegionalPriceRepository regionalPrices) {
    this.skills = skills;
    this.bundles = bundles;
    this.bundleMembers = bundleMembers;
    this.regionalPrices = regionalPrices;
  }

  @Override
  public Money quote(Ports.PurchaseKind kind, String targetId, String region) {
    return switch (kind) {
      case SKILL -> quoteSkill(targetId, region);
      case BUNDLE -> quoteBundle(targetId, region);
      // wallet_topup has no catalog row to price - SF1 explicitly carves it out as the one kind
      // where the client-supplied amount is honoured. Nothing should ever call quote() for it.
      case WALLET_TOPUP ->
          throw ApiException.validation(
              "wallet_topup has no catalog price; the client-supplied amount is authoritative (SF1)");
    };
  }

  private Money quoteSkill(String skillId, String region) {
    Skill skill = skills.findById(skillId).orElseThrow(() -> ApiException.notFound("skill " + skillId));
    Optional<Money> override = regionalOverride(Ports.PurchaseKind.SKILL, skillId, region);
    return override.orElseGet(() -> new Money(skill.getBasePrice(), skill.getBaseCurrency()));
  }

  private Money quoteBundle(String bundleId, String region) {
    Bundle bundle =
        bundles.findById(bundleId).orElseThrow(() -> ApiException.notFound("bundle " + bundleId));
    Optional<Money> override = regionalOverride(Ports.PurchaseKind.BUNDLE, bundleId, region);
    return override.orElseGet(() -> new Money(bundle.getBundlePrice(), bundle.getBaseCurrency()));
  }

  /**
   * {@code target_type} in {@code regional_prices} uses the exact same wire strings as {@link
   * Ports.PurchaseKind#wire()} for {@code skill}/{@code bundle} - deliberately, so no separate
   * vocabulary is needed here.
   */
  private Optional<Money> regionalOverride(Ports.PurchaseKind kind, String targetId, String region) {
    if (region == null || region.isBlank()) {
      return Optional.empty();
    }
    return regionalPrices
        .findByTargetTypeAndTargetIdAndRegion(kind.wire(), targetId, region)
        .map(rp -> new Money(rp.getPrice(), rp.getCurrency()));
  }

  @Override
  public List<String> memberSkills(Ports.PurchaseKind kind, String targetId) {
    return switch (kind) {
      case SKILL -> List.of(targetId);
      case BUNDLE ->
          bundleMembers.findByBundleId(targetId).stream().map(BundleMember::getSkillId).toList();
      case WALLET_TOPUP -> List.of(); // a top-up grants no skill
    };
  }

  @Override
  public void assertTargetExists(Ports.PurchaseKind kind, String targetId) {
    switch (kind) {
      case SKILL -> {
        if (!skills.existsById(targetId)) {
          throw ApiException.notFound("skill " + targetId);
        }
      }
      case BUNDLE -> {
        if (!bundles.existsById(targetId)) {
          throw ApiException.notFound("bundle " + targetId);
        }
      }
      case WALLET_TOPUP -> {
        // no target to validate - a top-up has no catalog referent.
      }
    }
  }
}
