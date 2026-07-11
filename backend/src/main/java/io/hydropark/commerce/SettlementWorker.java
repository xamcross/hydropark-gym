package io.hydropark.commerce;

import com.mongodb.MongoWriteException;
import com.mongodb.ErrorCategory;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.observability.TelemetryMetrics;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * §7.3 / §9 - the internal settlement worker. It is the ONLY holder of the MoR webhook secret and the
 * only principal that verifies signatures. It drains {@code webhook_events} rows in {@code received}
 * state and, for each, does the six-step pipeline:
 *
 * <ol>
 *   <li><b>Verify</b> the HMAC over the stored raw bytes, constant-time, before any parsing.
 *   <li><b>Dedupe</b> by claiming {@code provider_event_id} (a unique partial index makes a
 *       redelivery's claim fail, short-circuiting before any grant).
 *   <li><b>Correlate</b> via our own {@code orders.id} echoed in {@code custom_data}/{@code metadata}
 *       - never the provider's order id.
 *   <li>Assert {@code event.amount} <b>covers</b> {@code order.amount} in its currency.
 *   <li><b>Region cross-check (N9):</b> price at the higher tier or reject with a park.
 *   <li>In one transaction, flip the order, write {@code settled_orders}, and grant.
 * </ol>
 *
 * <p>Verification, correlation and the checks run OUTSIDE the transaction; only step 6 is
 * transactional (delegated to {@link SettlementService}). A parked event (bad amount/region) is
 * dead-lettered for review; a transient failure is retried until {@code maxAttempts}, then
 * dead-lettered.
 */
@Component
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
public class SettlementWorker {

  private static final Logger log = LoggerFactory.getLogger(SettlementWorker.class);

  private final MongoTemplate mongo;
  private final PaymentProvider provider;
  private final SettlementService settlement;
  private final PricingPort pricing;

  private final int batchSize;
  private final int maxAttempts;
  private final long staleProcessingMs;
  private final TelemetryMetrics metrics;

  /** Back-compat constructor (used by existing unit tests); no metrics wired. */
  public SettlementWorker(
      MongoTemplate mongo,
      PaymentProvider provider,
      SettlementService settlement,
      PricingPort pricing,
      int batchSize,
      int maxAttempts,
      long staleProcessingMs) {
    this(mongo, provider, settlement, pricing, batchSize, maxAttempts, staleProcessingMs,
        TelemetryMetrics.noop());
  }

  @Autowired
  public SettlementWorker(
      MongoTemplate mongo,
      PaymentProvider provider,
      SettlementService settlement,
      PricingPort pricing,
      @Value("${hydropark.worker.batch-size:50}") int batchSize,
      @Value("${hydropark.worker.max-attempts:5}") int maxAttempts,
      @Value("${hydropark.worker.stale-processing-ms:300000}") long staleProcessingMs,
      TelemetryMetrics metrics) {
    this.mongo = mongo;
    this.provider = provider;
    this.settlement = settlement;
    this.pricing = pricing;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.staleProcessingMs = staleProcessingMs;
    this.metrics = metrics;
  }

  @Scheduled(fixedDelayString = "${hydropark.worker.poll-interval-ms:2000}")
  public void drain() {
    try {
      Instant cutoff = Instant.now().minusMillis(staleProcessingMs);
      Query q =
          Query.query(
                  new Criteria()
                      .orOperator(
                          Criteria.where("status").is(WebhookEventStatus.RECEIVED.wire()),
                          new Criteria()
                              .andOperator(
                                  Criteria.where("status").is(WebhookEventStatus.PROCESSING.wire()),
                                  Criteria.where("processingAt").lt(cutoff))))
              .with(Sort.by(Sort.Direction.ASC, "receivedAt"))
              .limit(batchSize);
      List<WebhookEvent> candidates = mongo.find(q, WebhookEvent.class);
      for (WebhookEvent c : candidates) {
        WebhookEvent claimed = claimRow(c.getId());
        if (claimed != null) {
          processOne(claimed);
        }
      }
    } catch (RuntimeException e) {
      // Never let a poll tick kill the scheduler.
      log.error("settlement drain tick failed", e);
    }
  }

  /** Atomically move a claimable row to {@code processing} so a second worker instance can't take it. */
  WebhookEvent claimRow(String id) {
    Instant cutoff = Instant.now().minusMillis(staleProcessingMs);
    Query q =
        Query.query(
            new Criteria()
                .andOperator(
                    Criteria.where("id").is(id),
                    new Criteria()
                        .orOperator(
                            Criteria.where("status").is(WebhookEventStatus.RECEIVED.wire()),
                            new Criteria()
                                .andOperator(
                                    Criteria.where("status")
                                        .is(WebhookEventStatus.PROCESSING.wire()),
                                    Criteria.where("processingAt").lt(cutoff)))));
    Update u =
        new Update()
            .set("status", WebhookEventStatus.PROCESSING.wire())
            .set("processingAt", Instant.now());
    return mongo.findAndModify(
        q, u, FindAndModifyOptions.options().returnNew(true), WebhookEvent.class);
  }

  void processOne(WebhookEvent row) {
    // 1. Verify over the raw bytes, before parsing. Unverifiable can never succeed -> dead-letter.
    ProviderEvent ev;
    try {
      ev = provider.verifyWebhook(row.getHeaders(), row.getRawBody());
    } catch (WebhookVerificationException e) {
      log.warn("webhook {} failed verification: {}", row.getId(), e.getMessage());
      deadLetter(row.getId(), "signature: " + e.getMessage());
      return;
    }

    // subscription.* and anything unknown: acknowledge, do nothing (§7.3).
    if (ev.type() == null || PaymentProvider.IGNORED.equals(ev.type())) {
      markProcessed(row.getId(), "ignored");
      return;
    }
    if (ev.providerEventId() == null) {
      deadLetter(row.getId(), "event carried no provider_event_id");
      return;
    }

    // 2. Insert-first dedupe: claim provider_event_id. A duplicate means redelivery -> no grant.
    if (claimEventId(row.getId(), ev) == DedupeResult.DUPLICATE) {
      markProcessed(row.getId(), "duplicate:" + ev.providerEventId());
      return;
    }

    // 3. Correlate on OUR order id.
    if (ev.ourOrderId() == null) {
      deadLetter(row.getId(), "event carried no order correlation");
      return;
    }
    Order order = mongo.findById(ev.ourOrderId(), Order.class);
    if (order == null) {
      deadLetter(row.getId(), "unknown order " + ev.ourOrderId());
      return;
    }

    // 4-6. Checks + the transactional settlement.
    try {
      dispatch(order, ev);
      markProcessed(row.getId(), ev.type());
    } catch (ParkException pe) {
      log.warn("parking webhook {} for review: {}", row.getId(), pe.getMessage());
      deadLetter(row.getId(), pe.getMessage());
    } catch (RuntimeException e) {
      log.warn("settlement failed for event {} (will retry)", ev.providerEventId(), e);
      releaseForRetry(row);
    }
  }

  private void dispatch(Order order, ProviderEvent ev) {
    boolean isTopup = PurchaseKind.WALLET_TOPUP.wire().equals(order.getKind());
    switch (ev.type()) {
      case PaymentProvider.SUCCEEDED -> {
        if (isTopup) {
          settlement.settleTopup(order, ev);
        } else {
          // 4. Amount check: under-payment never settles.
          Money required = order.money();
          if (ev.amount() == null || !ev.amount().covers(required)) {
            throw new ParkException(
                "amount_mismatch: event does not cover order " + order.getId());
          }
          // 5. Region cross-check (N9).
          assertRegionAcceptable(order, ev);
          settlement.settleSkillOrBundle(order, ev);
        }
        metrics.orderSettled(); // P1-21.4: hydropark.orders.checkout.settled
        metrics.webhookSettled(); // P1-21.4: hydropark.webhook.settled
      }
      case PaymentProvider.REFUNDED -> {
        if (isTopup) {
          settlement.reverseTopup(order, false);
        } else {
          settlement.refundOrder(order);
        }
        metrics.orderRefunded(); // P1-21.4: hydropark.orders.checkout.refunded
      }
      case PaymentProvider.CHARGEBACK -> {
        if (isTopup) {
          settlement.reverseTopup(order, true);
        } else {
          settlement.chargebackOrder(order);
        }
      }
      default -> {
        /* ignored already handled */
      }
    }
  }

  /**
   * N9 - if the reported buyer geo contradicts the claimed region, require the paid amount to cover
   * the higher-priced tier; otherwise reject (park). A buyer in an expensive market cannot claim a
   * cheap region and pay the discounted base.
   */
  private void assertRegionAcceptable(Order order, ProviderEvent ev) {
    String buyer = ev.buyerCountry();
    if (buyer == null || buyer.isBlank() || buyer.equalsIgnoreCase(order.getRegion())) {
      return;
    }
    PurchaseKind kind = order.purchaseKind();
    Money claimed = pricing.quote(kind, order.getTargetId(), order.getRegion());
    Money actual = pricing.quote(kind, order.getTargetId(), buyer);
    Money higher = actual.amount() > claimed.amount() ? actual : claimed;
    if (ev.amount() == null || !ev.amount().covers(higher)) {
      throw new ParkException(
          "region_mismatch: buyer " + buyer + " contradicts claimed region " + order.getRegion());
    }
  }

  enum DedupeResult {
    CLAIMED,
    DUPLICATE
  }

  /**
   * Claim {@code provider_event_id} on this row. The partial-unique index on {@code provider_event_id}
   * means only one webhook_events row can ever hold a given event id, so a redelivery's claim fails
   * with a duplicate-key error - the insert-first short-circuit that guarantees exactly-once granting.
   */
  DedupeResult claimEventId(String rowId, ProviderEvent ev) {
    Update u =
        new Update()
            .set("providerEventId", ev.providerEventId())
            .set("orderId", ev.ourOrderId())
            .set("type", ev.type());
    // {provider_event_id: null} matches both missing AND explicit-null, so this is robust to how
    // the mapper serialized the (unset) field at edge-capture time.
    Query q = Query.query(Criteria.where("id").is(rowId).and("providerEventId").is(null));
    try {
      mongo.updateFirst(q, u, WebhookEvent.class);
      // modified==1: claimed now. modified==0: this row already carried the id from an earlier,
      // interrupted attempt -> proceed idempotently (settlement side-effects are all idempotent).
      return DedupeResult.CLAIMED;
    } catch (DuplicateKeyException dup) {
      return DedupeResult.DUPLICATE;
    } catch (MongoWriteException mwe) {
      if (mwe.getError().getCategory() == ErrorCategory.DUPLICATE_KEY) {
        return DedupeResult.DUPLICATE;
      }
      throw mwe;
    }
  }

  private void releaseForRetry(WebhookEvent row) {
    int attempts = row.getAttempts() + 1;
    if (attempts >= maxAttempts) {
      deadLetter(row.getId(), "max attempts exceeded (" + attempts + ")");
      return;
    }
    mongo.updateFirst(
        Query.query(Criteria.where("id").is(row.getId())),
        new Update()
            .set("status", WebhookEventStatus.RECEIVED.wire())
            .inc("attempts", 1)
            .unset("processingAt"),
        WebhookEvent.class);
  }

  private void deadLetter(String id, String reason) {
    metrics.webhookDeadLettered(); // P1-21.4: hydropark.webhook.deadlettered
    mongo.updateFirst(
        Query.query(Criteria.where("id").is(id)),
        new Update()
            .set("status", WebhookEventStatus.DEAD_LETTERED.wire())
            .set("lastError", reason)
            .set("processedAt", Instant.now()),
        WebhookEvent.class);
  }

  private void markProcessed(String id, String note) {
    mongo.updateFirst(
        Query.query(Criteria.where("id").is(id)),
        new Update()
            .set("status", WebhookEventStatus.PROCESSED.wire())
            .set("lastError", note)
            .set("processedAt", Instant.now()),
        WebhookEvent.class);
  }

  /** Signals an event that must be parked for manual review (bad amount / region), never retried. */
  static final class ParkException extends RuntimeException {
    ParkException(String message) {
      super(message);
    }
  }
}
