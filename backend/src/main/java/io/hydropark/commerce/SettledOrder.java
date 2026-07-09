package io.hydropark.commerce;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * §3.6 {@code settled_orders} - the append-only settlement log ({@code _id = order_id}). This is the
 * Issuer's authorization source (§6.2): before signing, it confirms the requested order appears
 * here. Only the settlement worker's DB role may write it (P1-21.7); that role split - not this
 * class - is what enforces "the web tier cannot fabricate a settlement" in production.
 *
 * <p>{@code chargebackBlocked} carries the SF10 account-wide issuance block. When any chargeback
 * lands for a user, every one of their settled_orders rows is flipped to {@code true}; a blocked row
 * is treated by {@link SettlementLogService#isSettledOrder} as NOT settled, so the Issuer refuses to
 * re-issue any license for that account. See the report note on the missing {@code isAccountBlocked}
 * port method.
 */
@Document(collection = "settled_orders")
public class SettledOrder {

  /** = order_id. */
  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("settled_at")
  private Instant settledAt;

  /** SF10 - set true across all of a user's rows once a chargeback lands. */
  @Field("chargeback_blocked")
  private boolean chargebackBlocked;

  protected SettledOrder() {}

  public SettledOrder(String orderId, String userId, Instant settledAt) {
    this.id = orderId;
    this.userId = userId;
    this.settledAt = settledAt;
    this.chargebackBlocked = false;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public Instant getSettledAt() {
    return settledAt;
  }

  public boolean isChargebackBlocked() {
    return chargebackBlocked;
  }
}
