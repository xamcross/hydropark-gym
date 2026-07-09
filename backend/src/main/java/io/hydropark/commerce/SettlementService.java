package io.hydropark.commerce;

import com.mongodb.client.result.UpdateResult;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.common.Uuid7;
import io.hydropark.port.Ports.GrantPort;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.WalletPort;
import io.hydropark.port.Ports.WalletPurchaseResult;
import java.time.Instant;
import java.util.List;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The transactional heart of the money path (§5.4, §5.5, §7.3). Every method here flips the order
 * status with a <b>guarded conditional update</b> ({@code {_id, status: <expected>}}) - never a
 * read-modify-write - so the monotonic state machine (B6) is enforced atomically. A flip that matches
 * zero documents means the order was not in the expected state (already terminal / already paid), and
 * the money side-effect is skipped.
 *
 * <p>The ownership-affecting methods run inside a single {@code @Transactional} boundary so the order
 * flip, the {@code settled_orders} write, and the grant/wallet mutation commit together or not at all.
 * The {@link GrantPort}/{@link WalletPort} calls join the ambient Mongo session automatically.
 *
 * <p>Gated to the worker zone: it is the only zone that mutates money/ownership, so its
 * {@link GrantPort}/{@link WalletPort}/{@link PricingPort} dependencies need not resolve elsewhere.
 */
@Service
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
public class SettlementService {

  private final MongoTemplate mongo;
  private final PricingPort pricing;
  private final GrantPort grants;
  private final WalletPort wallet;
  private final SettlementLogService settlementLog;
  private final AntiFraudService antiFraud;

  public SettlementService(
      MongoTemplate mongo,
      PricingPort pricing,
      GrantPort grants,
      WalletPort wallet,
      SettlementLogService settlementLog,
      AntiFraudService antiFraud) {
    this.mongo = mongo;
    this.pricing = pricing;
    this.wallet = wallet;
    this.grants = grants;
    this.settlementLog = settlementLog;
    this.antiFraud = antiFraud;
  }

  // ---------------------------------------------------------------------------------------------
  // MoR webhook actions (§7.3). Each returns whether the state actually transitioned, so the worker
  // knows whether a grant/credit was applied.
  // ---------------------------------------------------------------------------------------------

  /**
   * succeeded(skill/bundle): flip {@code pending -> paid} (write-once {@code mor_order_id}), write
   * {@code settled_orders}, create one grant per member skill. Returns false (no grant) if the order
   * was not {@code pending} - which is exactly how a refund-before-paid makes a late {@code succeeded}
   * a no-op.
   */
  @Transactional
  public boolean settleSkillOrBundle(Order order, ProviderEvent event) {
    Update u =
        new Update()
            .set("status", OrderStatus.PAID.wire())
            .set("updatedAt", Instant.now());
    if (event.providerOrderId() != null) {
      u.set("morOrderId", event.providerOrderId()); // write-once: only reached while still pending
    }
    long modified = flip(order.getId(), List.of(OrderStatus.PENDING), u);
    if (modified == 0) {
      return false; // monotonic guard: already paid / already terminal -> never re-grant
    }
    settlementLog.recordSettled(order.getId(), order.getUserId());
    PurchaseKind kind = order.purchaseKind();
    List<String> skillIds = pricing.memberSkills(kind, order.getTargetId());
    grants.createGrants(order.getUserId(), order.getId(), sourceFor(kind), skillIds);
    return true;
  }

  /** succeeded(wallet_topup): flip to paid and credit the settled top-up under the wallet lock. */
  @Transactional
  public boolean settleTopup(Order order, ProviderEvent event) {
    long modified =
        flip(
            order.getId(),
            List.of(OrderStatus.PENDING),
            new Update().set("status", OrderStatus.PAID.wire()).set("updatedAt", Instant.now()));
    if (modified == 0) {
      return false;
    }
    wallet.creditSettledTopup(
        order.getUserId(), order.getId(), order.money(), "credit:" + order.getId());
    return true;
  }

  /** refunded(skill/bundle): order -> refunded; flip only that order's grants (§5.3, B1). */
  @Transactional
  public boolean refundOrder(Order order) {
    long modified =
        flip(
            order.getId(),
            List.of(OrderStatus.PENDING, OrderStatus.PAID),
            new Update().set("status", OrderStatus.REFUNDED.wire()).set("updatedAt", Instant.now()));
    if (modified == 0) {
      return false;
    }
    grants.flipGrantsForOrder(order.getId(), GrantStatus.REFUNDED);
    return true;
  }

  /** chargeback(skill/bundle): order -> charged_back; flip its grants; block the account (SF10). */
  @Transactional
  public boolean chargebackOrder(Order order) {
    long modified =
        flip(
            order.getId(),
            List.of(OrderStatus.PENDING, OrderStatus.PAID),
            new Update()
                .set("status", OrderStatus.CHARGED_BACK.wire())
                .set("updatedAt", Instant.now()));
    if (modified == 0) {
      return false;
    }
    grants.flipGrantsForOrder(order.getId(), GrantStatus.CHARGED_BACK);
    settlementLog.blockAccountForChargeback(order.getUserId());
    return true;
  }

  /**
   * refund/chargeback(wallet_topup): clawback (may drive balance negative) + freeze the wallet, and,
   * on a chargeback, block the account. {@link WalletPort#clawbackTopup} also revokes wallet-funded
   * grants most-recent-first (§5.5 N5).
   */
  @Transactional
  public boolean reverseTopup(Order order, boolean chargeback) {
    OrderStatus target = chargeback ? OrderStatus.CHARGED_BACK : OrderStatus.REFUNDED;
    long modified =
        flip(
            order.getId(),
            List.of(OrderStatus.PENDING, OrderStatus.PAID),
            new Update().set("status", target.wire()).set("updatedAt", Instant.now()));
    if (modified == 0) {
      return false;
    }
    wallet.clawbackTopup(
        order.getUserId(), order.getId(), order.money(), "clawback:" + order.getId());
    if (chargeback) {
      settlementLog.blockAccountForChargeback(order.getUserId());
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Wallet spend (§5.4) - the worker is the sole price authority.
  // ---------------------------------------------------------------------------------------------

  /**
   * §5.4 Q1 - the fix for the v0.3 blocker where wallet purchases could never be licensed. The worker
   * derives the price itself (never trusting a client amount), then in one transaction: self-guarding
   * debit, a {@code paid} wallet order (no MoR round-trip), {@code settled_orders}, and grants - so a
   * wallet order reaches a settled, signable state by the same rule as a MoR order.
   */
  @Transactional
  public WalletPurchaseResult payWithWallet(
      String userId, PurchaseKind kind, String targetId, String region, String idempotencyKey) {
    if (kind == PurchaseKind.WALLET_TOPUP) {
      throw io.hydropark.common.ApiException.validation("wallet cannot fund a wallet top-up");
    }
    pricing.assertTargetExists(kind, targetId);
    Money price = pricing.quote(kind, targetId, region); // SOLE price authority (SF1)
    antiFraud.assertWorkerPurchaseAllowed(userId);

    String orderId = Uuid7.generate();
    Instant now = Instant.now();
    Order order =
        new Order(
            orderId,
            userId,
            kind,
            targetId,
            price,
            PaymentSource.WALLET,
            null,
            region,
            OrderStatus.PAID,
            now);
    mongo.insert(order);

    // Self-guarding debit; throws INSUFFICIENT_BALANCE / WALLET_FROZEN / WALLET_CURRENCY_MISMATCH,
    // which rolls the whole transaction back (no order, no grant).
    wallet.debitForOrder(userId, orderId, price, idempotencyKey);

    settlementLog.recordSettled(orderId, userId);
    List<String> skillIds = pricing.memberSkills(kind, targetId);
    grants.createGrants(userId, orderId, sourceFor(kind), skillIds);
    return new WalletPurchaseResult(orderId, skillIds);
  }

  // ---------------------------------------------------------------------------------------------

  private long flip(String orderId, List<OrderStatus> from, Update update) {
    List<String> wires = from.stream().map(OrderStatus::wire).toList();
    Query guard = Query.query(Criteria.where("id").is(orderId).and("status").in(wires));
    UpdateResult r = mongo.updateFirst(guard, update, Order.class);
    return r.getModifiedCount();
  }

  private static GrantSource sourceFor(PurchaseKind kind) {
    return kind == PurchaseKind.BUNDLE ? GrantSource.BUNDLE : GrantSource.STANDALONE;
  }
}
