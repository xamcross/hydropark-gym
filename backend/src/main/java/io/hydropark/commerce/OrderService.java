package io.hydropark.commerce;

import io.hydropark.common.ApiException;
import io.hydropark.common.CursorPage;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.SettlementPort;
import io.hydropark.port.Ports.WalletPort;
import io.hydropark.port.Ports.WalletPurchaseResult;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * §4.3 - the public order surface. It creates orders with a <b>server-derived</b> price (SF1),
 * launches MoR checkouts, and routes wallet-funded purchases to the settlement worker via
 * {@link SettlementPort} (never sending a price). It never grants or settles - that is the worker's
 * job alone. Gated to the api zone (it is the public order surface).
 */
@Service
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class OrderService {

  /**
   * §4.7 - a wallet top-up is the ONE purchase kind whose client-supplied amount is authoritative
   * (SF1's single exception): every other kind derives its price from the catalog via
   * {@link PricingPort}, but a top-up has no catalog target - the user names how much credit to buy.
   * The amount is still bounded to a sane range. There is no config field for these (mirroring
   * {@code AntiFraudService.HIGH_VALUE_MINOR}); see the report.
   */
  static final long MIN_TOPUP_MINOR = 100L; // e.g. $1.00

  static final long MAX_TOPUP_MINOR = 1_000_000L; // e.g. $10,000.00

  /** Currency a first top-up defaults to when the client omits it (the §4.7 body is {amount, region}). */
  static final String DEFAULT_TOPUP_CURRENCY = "USD";

  private final MongoTemplate mongo;
  private final PricingPort pricing;
  private final PaymentProvider provider;
  private final SettlementPort settlement;
  private final WalletPort wallet;
  private final AntiFraudService antiFraud;
  private final AppProperties props;

  public OrderService(
      MongoTemplate mongo,
      PricingPort pricing,
      PaymentProvider provider,
      SettlementPort settlement,
      WalletPort wallet,
      AntiFraudService antiFraud,
      AppProperties props) {
    this.mongo = mongo;
    this.pricing = pricing;
    this.provider = provider;
    this.settlement = settlement;
    this.wallet = wallet;
    this.antiFraud = antiFraud;
    this.props = props;
  }

  public CheckoutResponse checkout(
      String userId, boolean emailVerified, CheckoutRequest req, String idempotencyKey) {
    PurchaseKind kind = PurchaseKind.fromWire(req.kind());
    PaymentSource source = PaymentSource.fromWire(req.paymentSource());
    String region = requireRegion(req.region());

    if (kind == PurchaseKind.WALLET_TOPUP) {
      if (source == PaymentSource.WALLET) {
        throw ApiException.validation("a wallet top-up cannot be funded from the wallet");
      }
      // Shares the exact validated path as POST /v1/wallet/topup so this route can never bypass the
      // at-checkout currency guard (which would strand a captured payment at settlement, §3.5).
      return startTopup(userId, emailVerified, req.amount(), req.currency(), region);
    }

    // skill / bundle
    String targetId = requireTarget(req.targetId());
    pricing.assertTargetExists(kind, targetId);
    Money price = pricing.quote(kind, targetId, region); // server-derived; client amount ignored
    antiFraud.assertPurchaseAllowed(userId, emailVerified, kind, price);

    if (source == PaymentSource.WALLET) {
      WalletPurchaseResult r =
          settlement.payWithWallet(userId, kind, targetId, region, idempotencyKey);
      return new CheckoutResponse(r.orderId(), null, r.ownedSkillIds());
    }
    Order order = createMorOrder(userId, kind, targetId, price, region);
    return morResponse(order, region);
  }

  public WalletPurchaseResponse payWallet(
      String userId, boolean emailVerified, PayWalletRequest req, String idempotencyKey) {
    PurchaseKind kind = PurchaseKind.fromWire(req.kind());
    if (kind == PurchaseKind.WALLET_TOPUP) {
      throw ApiException.validation("wallet cannot fund a wallet top-up");
    }
    String targetId = requireTarget(req.targetId());
    String region = requireRegion(req.region());
    pricing.assertTargetExists(kind, targetId);
    // Derived locally for the eligibility gate only; NEVER transmitted (the worker re-derives it).
    Money price = pricing.quote(kind, targetId, region);
    antiFraud.assertPurchaseAllowed(userId, emailVerified, kind, price);

    WalletPurchaseResult r = settlement.payWithWallet(userId, kind, targetId, region, idempotencyKey);
    return WalletPurchaseResponse.of(r);
  }

  /**
   * §4.7 {@code POST /v1/wallet/topup} - starts a wallet top-up as a MoR checkout. A top-up <b>is</b>
   * an order ({@code kind=wallet_topup}) that needs a checkout session, which is why it lives here in
   * {@code commerce} (holder of {@link PaymentProvider} and the {@code orders} collection) rather than
   * in {@code wallet}. A top-up is always MoR-funded (you cannot pay for wallet credit from the
   * wallet), so there is no {@code payment_source} to consider.
   */
  public CheckoutResponse topup(
      String userId, boolean emailVerified, TopupRequest req, String idempotencyKey) {
    return startTopup(userId, emailVerified, req.amount(), req.currency(), requireRegion(req.region()));
  }

  public OrderView getOrder(String userId, String orderId) {
    Order o = mongo.findById(orderId, Order.class);
    if (o == null || !o.getUserId().equals(userId)) {
      throw ApiException.notFound("order");
    }
    return OrderView.of(o);
  }

  public CursorPage<OrderView> listOrders(String userId, String cursor, Integer limit) {
    int lim = CursorPage.clampLimit(limit);
    Criteria c = Criteria.where("userId").is(userId);
    String cursorId = CursorPage.decode(cursor);
    if (cursorId != null) {
      c = c.and("id").lt(cursorId);
    }
    Query q = Query.query(c).with(Sort.by(Sort.Direction.DESC, "id")).limit(lim + 1);
    List<OrderView> rows = mongo.find(q, Order.class).stream().map(OrderView::of).toList();
    return CursorPage.from(rows, lim, OrderView::orderId);
  }

  /**
   * The single validated top-up path. Validates the (authoritative) client amount and resolves the
   * currency <b>before</b> creating the checkout, so a mismatched currency is rejected while no money
   * has moved. Never calls {@link PricingPort#quote} - that throws for {@code WALLET_TOPUP} by design
   * (the catalog is not the price authority for top-ups).
   */
  private CheckoutResponse startTopup(
      String userId, boolean emailVerified, Long amount, String currencyReq, String region) {
    long amt = requireTopupAmount(amount);
    String currency = resolveTopupCurrency(userId, currencyReq);
    Money price = new Money(amt, currency); // client amount honoured - the wallet_topup exception to SF1
    antiFraud.assertPurchaseAllowed(userId, emailVerified, PurchaseKind.WALLET_TOPUP, price);
    Order order = createMorOrder(userId, PurchaseKind.WALLET_TOPUP, null, price, region);
    return morResponse(order, region);
  }

  /**
   * §3.5 - the wallet currency is fixed at its first top-up. If it is already fixed and the request
   * asks for a different currency, reject with {@code WALLET_CURRENCY_MISMATCH} (409) <b>here, at
   * checkout</b>: catching it at settlement would mean the money is already captured and
   * {@code creditSettledTopup} would have to strand a real payment or silently convert. A first
   * top-up sets the currency (defaulting to {@link #DEFAULT_TOPUP_CURRENCY} when the client omits it).
   */
  private String resolveTopupCurrency(String userId, String currencyReq) {
    String requested =
        (currencyReq == null || currencyReq.isBlank()) ? null : currencyReq.trim().toUpperCase();
    Optional<String> fixed = wallet.currencyOf(userId);
    if (fixed.isPresent()) {
      if (requested != null && !requested.equalsIgnoreCase(fixed.get())) {
        throw new ApiException(
            ErrorCode.WALLET_CURRENCY_MISMATCH,
            "wallet holds " + fixed.get() + "; top up in that currency",
            Map.of("wallet_currency", fixed.get(), "requested_currency", requested));
      }
      return fixed.get();
    }
    return requested != null ? requested : DEFAULT_TOPUP_CURRENCY;
  }

  /**
   * §4.7 SF1 - {@code wallet_topup} is the one kind where the client amount is authoritative, so it is
   * validated (not derived): a positive integer in minor units, within a sane min/max.
   */
  private static long requireTopupAmount(Long amount) {
    if (amount == null) {
      throw ApiException.validation("amount is required for a wallet top-up");
    }
    long a = amount;
    if (a < MIN_TOPUP_MINOR || a > MAX_TOPUP_MINOR) {
      throw ApiException.validation(
          "top-up amount must be between "
              + MIN_TOPUP_MINOR
              + " and "
              + MAX_TOPUP_MINOR
              + " minor units");
    }
    return a;
  }

  private Order createMorOrder(
      String userId, PurchaseKind kind, String targetId, Money price, String region) {
    Order order =
        new Order(
            io.hydropark.common.Uuid7.generate(),
            userId,
            kind,
            targetId,
            price,
            PaymentSource.MOR,
            props.getPayments().getProvider(),
            region,
            OrderStatus.PENDING,
            Instant.now());
    mongo.insert(order);
    return order;
  }

  private CheckoutResponse morResponse(Order order, String region) {
    PaymentProvider.CheckoutSession cs = provider.createCheckout(order, region);
    return new CheckoutResponse(order.getId(), cs.checkoutUrl(), null);
  }

  private static String requireRegion(String region) {
    if (region == null || region.isBlank()) {
      throw ApiException.validation("region is required");
    }
    return region;
  }

  private static String requireTarget(String targetId) {
    if (targetId == null || targetId.isBlank()) {
      throw ApiException.validation("target_id is required");
    }
    return targetId;
  }
}
