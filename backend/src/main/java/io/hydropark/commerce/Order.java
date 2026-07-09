package io.hydropark.commerce;

import io.hydropark.common.Money;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * §3.3 {@code orders} - one row per purchase attempt (single skill, bundle, or wallet top-up).
 *
 * <p>{@code id} is OUR id and the correlation anchor (B2): it is handed to the MoR as
 * {@code custom_data}/{@code client_reference_id}, so every webhook echoes it and the worker joins
 * on it - never on the provider's own order id, which does not exist at checkout-creation time.
 *
 * <p>{@code amount}/{@code currency} are SERVER-DERIVED for skill/bundle (the client value is ignored
 * - SF1). {@code region} is the client-claimed price region, retained so the settlement worker can
 * cross-check it against the MoR-reported buyer geo (N9). {@code status} is monotonic (see
 * {@link OrderStatus}).
 */
@Document(collection = "orders")
public class Order {

  @Id private String id;

  @Field("user_id")
  private String userId;

  /** {@link PurchaseKind#wire()}: {@code skill | bundle | wallet_topup}. */
  @Field("kind")
  private String kind;

  /** skill_id / bundle_id / null for top-up. Validated at write time (no FK, §11.2 #3). */
  @Field("target_id")
  private String targetId;

  @Field("amount")
  private long amount;

  @Field("currency")
  private String currency;

  /** {@link PaymentSource#wire()}. */
  @Field("payment_source")
  private String paymentSource;

  /** {@code stripe | fake | null (wallet)}. */
  @Field("mor_provider")
  private String morProvider;

  /** The provider's id: null at creation, write-once on the first webhook (B2). */
  @Field("mor_order_id")
  private String morOrderId;

  /** Client-claimed price region; cross-checked against buyer geo at settlement (N9). */
  @Field("region")
  private String region;

  /** {@link OrderStatus#wire()} - monotonic. */
  @Field("status")
  private String status;

  @Field("created_at")
  private Instant createdAt;

  @Field("updated_at")
  private Instant updatedAt;

  protected Order() {}

  public Order(
      String id,
      String userId,
      PurchaseKind kind,
      String targetId,
      Money price,
      PaymentSource paymentSource,
      String morProvider,
      String region,
      OrderStatus status,
      Instant now) {
    this.id = id;
    this.userId = userId;
    this.kind = kind.wire();
    this.targetId = targetId;
    this.amount = price.amount();
    this.currency = price.currency();
    this.paymentSource = paymentSource.wire();
    this.morProvider = morProvider;
    this.region = region;
    this.status = status.wire();
    this.createdAt = now;
    this.updatedAt = now;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getKind() {
    return kind;
  }

  public PurchaseKind purchaseKind() {
    return PurchaseKind.fromWire(kind);
  }

  public String getTargetId() {
    return targetId;
  }

  public long getAmount() {
    return amount;
  }

  public String getCurrency() {
    return currency;
  }

  public Money money() {
    return new Money(amount, currency);
  }

  public String getPaymentSource() {
    return paymentSource;
  }

  public String getMorProvider() {
    return morProvider;
  }

  public String getMorOrderId() {
    return morOrderId;
  }

  public String getRegion() {
    return region;
  }

  public String getStatus() {
    return status;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }
}
