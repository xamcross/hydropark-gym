package io.hydropark.licensing;

import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * One ownership grant per {@code (order line -> skill)} (BACKEND-DESIGN §3.3, SPEC §13.11).
 *
 * <p>Effective ownership is derived, never stored: a user owns a skill while <b>at least one</b>
 * grant for it is {@code active}. A user may legitimately hold several grants for the same skill
 * (e.g. bought standalone <em>and</em> inside a bundle), which is exactly why there is <b>no</b>
 * unique index on {@code (user_id, skill_id)} - refunding one grant must not strip the other. The
 * only uniqueness is {@code (order_id, skill_id)}, which makes {@link GrantService#createGrants}
 * idempotent under webhook redelivery.
 *
 * <p>{@code payment_source} and {@code price_minor} are denormalised from the order at grant time so
 * the wallet-chargeback clawback walk (§5.5) is a single-collection scan and never has to join back
 * to {@code orders}.
 */
@Document(collection = "grants")
public class Grant {

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("skill_id")
  private String skillId;

  /** {@code standalone} | {@code bundle} - {@link GrantSource#wire()}. */
  @Field("source")
  private String source;

  @Field("order_id")
  private String orderId;

  /** {@code mor} | {@code wallet} - denormalised from the order; drives the clawback filter. */
  @Field("payment_source")
  private String paymentSource;

  /** The price this grant was bought at, minor units - the clawback walk sums these. */
  @Field("price_minor")
  private long priceMinor;

  /** ISO-4217, denormalised from the order (informational; a wallet is single-currency). */
  @Field("currency")
  private String currency;

  /** {@code active} | {@code refunded} | {@code charged_back} | {@code revoked}. */
  @Field("status")
  private String status;

  @Field("granted_at")
  private Instant grantedAt;

  @Field("revoked_at")
  private Instant revokedAt;

  public Grant() {}

  public static Grant create(
      String id,
      String userId,
      String skillId,
      GrantSource source,
      String orderId,
      String paymentSource,
      String currency,
      long priceMinor,
      Instant grantedAt) {
    Grant g = new Grant();
    g.id = id;
    g.userId = userId;
    g.skillId = skillId;
    g.source = source.wire();
    g.orderId = orderId;
    g.paymentSource = paymentSource;
    g.currency = currency;
    g.priceMinor = priceMinor;
    g.status = GrantStatus.ACTIVE.wire();
    g.grantedAt = grantedAt;
    g.revokedAt = null;
    return g;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getSkillId() {
    return skillId;
  }

  public String getSource() {
    return source;
  }

  public String getOrderId() {
    return orderId;
  }

  public String getPaymentSource() {
    return paymentSource;
  }

  public long getPriceMinor() {
    return priceMinor;
  }

  public String getCurrency() {
    return currency;
  }

  public String getStatus() {
    return status;
  }

  public Instant getGrantedAt() {
    return grantedAt;
  }

  public Instant getRevokedAt() {
    return revokedAt;
  }
}
