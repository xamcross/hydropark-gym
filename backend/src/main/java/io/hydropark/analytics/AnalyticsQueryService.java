package io.hydropark.analytics;

import io.hydropark.analytics.AnalyticsRollupService.PaidOrderRow;
import io.hydropark.analytics.AnalyticsRollupService.RollupInputs;
import io.hydropark.analytics.AnalyticsRollupService.RollupResult;
import io.hydropark.analytics.CacLtvService.CacLtvReport;
import io.hydropark.analytics.CacLtvService.ChannelEconomics;
import io.hydropark.analytics.CacLtvService.ChannelInputs;
import io.hydropark.analytics.GrossMarginService.GrossMarginInputs;
import io.hydropark.analytics.GrossMarginService.GrossMarginResult;
import io.hydropark.analytics.Phase1To2GateService.Phase1To2GateInputs;
import io.hydropark.analytics.Phase1To2GateService.Phase1To2GateResult;
import io.hydropark.auth.domain.User;
import io.hydropark.commerce.Order;
import io.hydropark.commerce.OrderStatus;
import io.hydropark.licensing.Grant;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.PurchaseKind;
import java.util.List;
import org.bson.Document;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.aggregation.Aggregation;
import org.springframework.data.mongodb.core.aggregation.AggregationResults;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * The single place analytics touches Mongo. It fetches the rows/counts each pure service needs
 * ({@link AnalyticsRollupService}, {@link GrossMarginService}, {@link CacLtvService},
 * {@link Phase1To2GateService}) and delegates the arithmetic to them, mirroring how
 * {@link io.hydropark.observability.MetricsConfig} isolates its datastore reads. Gated to the api zone
 * (the public read surface); the money-path collections it reads live in the same Atlas database.
 *
 * <p><b>Known gaps, wired conservatively (never fabricated):</b>
 *
 * <ul>
 *   <li><b>Retention D7/D30</b> needs client product-metric events (P1-25.1); until those land it
 *       reports 0, so the Phase-1→2 gate's second condition reads NO-GO rather than guessing.
 *   <li><b>Per-channel attribution</b> needs install-source events (P1-25.1/.4); until then a single
 *       blended {@code "organic"} channel is reported, with the operator-configured content cost
 *       ({@code hydropark.analytics.content-cost-minor}) as its organic CAC. The math in
 *       {@link CacLtvService} already supports N channels for when attribution lands.
 *   <li><b>CDN cost</b> is 0 unless {@code hydropark.analytics.cost-per-gb-egress-minor} is set - the
 *       margin gate is only as honest as that configured price.
 * </ul>
 */
@Service
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class AnalyticsQueryService {

  private final MongoTemplate mongo;
  private final AnalyticsProperties props;
  private final AnalyticsRollupService rollups;
  private final GrossMarginService margins;
  private final CacLtvService cacLtv;
  private final Phase1To2GateService phaseGate;

  public AnalyticsQueryService(
      MongoTemplate mongo,
      AnalyticsProperties props,
      AnalyticsRollupService rollups,
      GrossMarginService margins,
      CacLtvService cacLtv,
      Phase1To2GateService phaseGate) {
    this.mongo = mongo;
    this.props = props;
    this.rollups = rollups;
    this.margins = margins;
    this.cacLtv = cacLtv;
    this.phaseGate = phaseGate;
  }

  public RollupResult overview() {
    return rollups.rollup(rollupInputs());
  }

  public GrossMarginResult margin() {
    return margins.evaluate(marginInputs());
  }

  public CacLtvReport ltv() {
    return cacLtv.evaluate(channelInputs(overview()), props.getLtvToCacTarget());
  }

  public Phase1To2GateResult phaseGate() {
    RollupResult overview = overview();
    ChannelEconomics blended =
        cacLtv.evaluate(channelInputs(overview), props.getLtvToCacTarget()).blended();
    return phaseGate.evaluate(
        new Phase1To2GateInputs(
            blended.ltvPerInstallMinor(),
            blended.cacPerInstallMinor(),
            props.getLtvToCacTarget(),
            overview.netArpuMinorPerUser(),
            // Retention D30 is 0 until P1-25.1 client events land, so condition 2 reads NO-GO
            // conservatively rather than being guessed.
            overview.retentionD30()));
  }

  // ---------------------------------------------------------------------------------------------
  // Mongo I/O - assembles the pre-fetched inputs the pure services consume.
  // ---------------------------------------------------------------------------------------------

  private RollupInputs rollupInputs() {
    long userCount = mongo.count(new Query(), User.class);
    List<PaidOrderRow> paidRows =
        paidSkillAndBundleOrders().stream()
            .map(o -> new PaidOrderRow(o.getUserId(), o.purchaseKind(), o.getAmount()))
            .toList();
    long activePaidGrants =
        mongo.count(
            Query.query(Criteria.where("status").is(GrantStatus.ACTIVE.wire())), Grant.class);
    long refunded = countOrdersByStatus(OrderStatus.REFUNDED);
    long chargedBack = countOrdersByStatus(OrderStatus.CHARGED_BACK);

    // Retention needs P1-25.1 client events; report 0 until they land (see class doc).
    return new RollupInputs(
        userCount, paidRows, activePaidGrants, refunded, chargedBack, 0L, 0L, 0L, props.feeModel());
  }

  private GrossMarginInputs marginInputs() {
    long userCount = mongo.count(new Query(), User.class);
    List<Order> paid = paidSkillAndBundleOrders();
    long grossSales = paid.stream().mapToLong(Order::getAmount).sum();
    long settledOrders = paid.size();
    // Every served byte is a real CDN delivery cost against revenue: the free base-model pulls
    // (§26.2's headline per-install cost) plus all skill-package egress (buyer downloads + free
    // owned-skill re-downloads). A finer paid-vs-free split lands with per-object egress attribution.
    long modelEgressBytes = sumEgressBytes("model");
    long freeReDownloadEgressBytes = sumEgressBytes("skill");
    return new GrossMarginInputs(
        userCount,
        grossSales,
        settledOrders,
        modelEgressBytes,
        freeReDownloadEgressBytes,
        props.feeModel(),
        props.getCostPerGbEgressMinor());
  }

  /**
   * Until install-source attribution lands (P1-25.1/.4) all installs/payers/net-revenue roll into one
   * blended {@code "organic"} channel, whose CAC is the configured content/production cost.
   */
  private List<ChannelInputs> channelInputs(RollupResult overview) {
    long netRevenueMinor = Math.round(overview.netRevenueMinorAfterFees());
    return List.of(
        new ChannelInputs(
            "organic",
            overview.userCount(),
            overview.payerCount(),
            netRevenueMinor,
            props.getContentCostMinor()));
  }

  private List<Order> paidSkillAndBundleOrders() {
    return mongo.find(
        Query.query(
            Criteria.where("status")
                .is(OrderStatus.PAID.wire())
                .and("kind")
                .in(PurchaseKind.SKILL.wire(), PurchaseKind.BUNDLE.wire())),
        Order.class);
  }

  private long countOrdersByStatus(OrderStatus status) {
    return mongo.count(Query.query(Criteria.where("status").is(status.wire())), Order.class);
  }

  /** Sum of served bytes for an {@code object_type} in {@code cdn_egress}; 0 when there are none. */
  private long sumEgressBytes(String objectType) {
    Aggregation agg =
        Aggregation.newAggregation(
            Aggregation.match(Criteria.where("object_type").is(objectType)),
            Aggregation.group().sum("bytes").as("total"));
    AggregationResults<Document> res = mongo.aggregate(agg, "cdn_egress", Document.class);
    Document d = res.getUniqueMappedResult();
    Object total = d == null ? null : d.get("total");
    return total instanceof Number n ? n.longValue() : 0L;
  }
}
