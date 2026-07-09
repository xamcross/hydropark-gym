package io.hydropark.port;

import io.hydropark.common.Money;
import java.util.List;

/**
 * Cross-package contracts. Each port is implemented in exactly one package and consumed elsewhere,
 * which keeps the module graph acyclic:
 *
 * <pre>
 *   catalog    implements PricingPort
 *   licensing  implements GrantPort
 *   commerce   implements SettlementLogPort
 *   wallet     implements WalletPort
 *   devices    implements DeviceSlotPort
 *   auth       implements StepUpPort
 * </pre>
 *
 * <p>All port methods that mutate money or ownership are invoked from inside a single
 * {@code @Transactional} settlement-worker call, so they join the ambient Mongo session
 * automatically - do not open your own session inside an implementation.
 */
public final class Ports {
  private Ports() {}

  /** What a purchasable thing is. Mirrors {@code orders.kind}. */
  public enum PurchaseKind {
    SKILL("skill"),
    BUNDLE("bundle"),
    WALLET_TOPUP("wallet_topup");

    private final String wire;

    PurchaseKind(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static PurchaseKind fromWire(String s) {
      for (PurchaseKind k : values()) {
        if (k.wire.equals(s)) {
          return k;
        }
      }
      throw io.hydropark.common.ApiException.validation("unknown kind: " + s);
    }
  }

  /** §3.3 grants.status */
  public enum GrantStatus {
    ACTIVE("active"),
    REFUNDED("refunded"),
    CHARGED_BACK("charged_back"),
    REVOKED("revoked");

    private final String wire;

    GrantStatus(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public boolean isTerminal() {
      return this != ACTIVE;
    }
  }

  /** §3.3 grants.source */
  public enum GrantSource {
    STANDALONE("standalone"),
    BUNDLE("bundle");

    private final String wire;

    GrantSource(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }
  }

  /**
   * Implemented by {@code catalog}. The <b>settlement worker</b> is the sole price authority
   * (§5.5.4): it calls this itself rather than trusting any client-supplied amount (SF1).
   */
  public interface PricingPort {
    /** Server-authoritative price for (kind, target, region). Falls back to base_price. */
    Money quote(PurchaseKind kind, String targetId, String region);

    /**
     * The skill ids a purchase grants. A {@code SKILL} yields one; a {@code BUNDLE} yields one per
     * member (§5.6 - one grant per member skill).
     */
    List<String> memberSkills(PurchaseKind kind, String targetId);

    /** Write-time referential validation - Mongo has no cross-collection FK (§11.2 #3). */
    void assertTargetExists(PurchaseKind kind, String targetId);
  }

  /** Implemented by {@code licensing}. Ownership is grants, never a mutable entitlement row. */
  public interface GrantPort {
    /** Idempotent per {@code (order_id, skill_id)} - safe under webhook redelivery. */
    void createGrants(String userId, String orderId, GrantSource source, List<String> skillIds);

    /**
     * §5.5.3 - a reversal flips only the grants tied to that order. A skill still covered by another
     * active grant (e.g. a bundle) stays owned.
     */
    void flipGrantsForOrder(String orderId, GrantStatus newStatus);

    /** Effective entitlement: at least one grant with status=active. */
    boolean hasActiveGrant(String userId, String skillId);

    /**
     * §5.5.5 N5 - wallet clawback walks currently-active, wallet-funded grants most-recent-first up
     * to {@code amountMinorUnits}, revoking each in full. Returns the revoked grant ids.
     */
    List<String> revokeWalletGrantsMostRecentFirst(String userId, long amountMinorUnits);
  }

  /**
   * Implemented by {@code commerce}. The append-only settlement log is the Issuer's authorization
   * source (§6.2, §3.5). Only the settlement worker's DB role may write it (P1-21.7).
   */
  public interface SettlementLogPort {
    void recordSettled(String orderId, String userId);

    /**
     * The Issuer calls this - never "does some settled order exist for this user", but "is there an
     * active grant for exactly this (user, skill) whose order settled". Binding to the exact pair is
     * what stops a compromised internal caller minting an arbitrary-skill license.
     */
    boolean isSettledOrder(String orderId);
  }

  /** Implemented by {@code wallet}. */
  public interface WalletPort {

    /**
     * The currency this wallet is fixed to (set at first top-up), or empty if it has never been
     * topped up.
     *
     * <p>Exists so {@code commerce} can reject a mismatched top-up <b>at checkout</b>. Discovering
     * the mismatch at settlement time would be far worse: the money is already captured, and
     * {@code creditSettledTopup} would have to either throw (stranding a real payment with no
     * credit) or silently convert. Validate before taking the money.
     */
    java.util.Optional<String> currencyOf(String userId);
    /**
     * Self-guarding conditional debit (§5.5 concurrency): a single atomic findOneAndUpdate matching
     * {@code status=active AND balance >= amount}. Throws INSUFFICIENT_BALANCE / WALLET_FROZEN /
     * WALLET_CURRENCY_MISMATCH rather than returning a boolean.
     */
    void debitForOrder(String userId, String orderId, Money price, String idempotencyKey);

    /** Credit a settled top-up. Spendable only once {@code settled=true}. */
    void creditSettledTopup(String userId, String orderId, Money amount, String idempotencyKey);

    /** §5.5.5 - compensating negative row + freeze. Balance may go negative; never clamped. */
    void clawbackTopup(String userId, String orderId, Money amount, String idempotencyKey);
  }

  /** Implemented by {@code devices}. */
  public interface DeviceSlotPort {
    /** Throws SLOT_LIMIT_REACHED / NOT_FOUND / FORBIDDEN if the device can't mint a license. */
    void assertActiveSlot(String userId, String deviceId);

    /** §3.4 - coarse fingerprint, server-side only, never re-derived offline. */
    String fingerprintOf(String deviceId);
  }

  /**
   * The step-up action vocabulary. These strings cross a package boundary and are persisted in
   * {@code step_up_challenges.action}, so they have exactly ONE definition - here.
   *
   * <p>They were briefly defined twice (once in {@code auth}, once at each call site) and drifted:
   * {@code devices} asked for {@code "devices.register"} while {@code auth} recognised
   * {@code "device.register"}. Nothing failed to compile; instead the trust-on-first-use branch
   * silently never matched, and no new account could ever bind its first device. A stringly-typed
   * contract with two owners will drift again - prefer promoting this to an enum on the
   * {@link StepUpPort} signature when the churn is affordable.
   */
  public static final class StepUpActions {
    private StepUpActions() {}

    public static final String DEVICE_REGISTER = "device.register";
    public static final String LICENSE_ISSUE = "license.issue";
    public static final String DEVICE_DEAUTHORIZE_LAST = "device.deauthorize_last";
  }

  /**
   * Implemented by {@code auth}. §8 SF11 - perpetual effects need device confirmation beyond the
   * 15-minute access token.
   */
  public interface StepUpPort {
    /**
     * Verifies a step-up proof for this user. Throws STEP_UP_REQUIRED when absent/invalid.
     *
     * @param proof the {@code X-Step-Up-Token} header value, may be null
     */
    void assertStepUp(String userId, String proof, String action);
  }

  // ---------------------------------------------------------------------------------------------
  // Trust-zone crossings.
  //
  // The api zone must never hold the Ed25519 keys or the MoR webhook secret. When zones run as
  // separate containers (compose, Fly) the api reaches them over the internal network; when they
  // run in one JVM (local dev, tests) it calls them directly. Both sides of each port are wired by
  // @ConditionalOnProperty on the zone flags, so the *call sites* never know which they got - and a
  // developer cannot accidentally collapse the boundary by injecting the signer directly.
  //
  // Isolation is not authorization (§6.2 N3): the remote implementations are a network boundary,
  // not a permission. The Issuer re-verifies settlement itself on every call regardless of who asked.
  // ---------------------------------------------------------------------------------------------

  public record IssuedLicense(String licenseId, String token, String kid) {}

  /** Implemented twice in {@code licensing}: in-process signer, or HTTP client to the issuer app. */
  public interface LicenseIssuerPort {
    /**
     * Mints a per-device license. The implementation MUST independently confirm an active grant for
     * exactly this {@code (userId, skillId)} whose order appears in {@code settled_orders} before
     * signing - never trusting that the caller already checked.
     */
    IssuedLicense issue(String userId, String skillId, String deviceId);
  }

  public record WalletPurchaseResult(String orderId, List<String> ownedSkillIds) {}

  /** Implemented twice in {@code commerce}: in-process worker, or HTTP client to the worker app. */
  public interface SettlementPort {
    /**
     * §5.5.4 - the public handler forwards {@code (user, kind, target, region)} and <b>never a
     * price</b>. The settlement worker is the sole price authority: it derives the amount itself, so
     * a compromised web tier cannot dictate what a skill costs.
     */
    WalletPurchaseResult payWithWallet(
        String userId, PurchaseKind kind, String targetId, String region, String idempotencyKey);
  }
}
