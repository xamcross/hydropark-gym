package io.hydropark.wallet;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.5 - the <b>append-only</b> wallet ledger. {@link WalletAccount#getBalance()} is a
 * materialized cache of the settled sum of these rows; the rows are the truth.
 *
 * <p>{@link #idempotencyKey} is <b>unique</b>. Double-apply is prevented by relying on the
 * duplicate-key error on insert (BE §3.5, Appendix A), never by a pre-read - the same insert-first
 * discipline the webhook dedupe uses.
 */
@Document(collection = "wallet_transactions")
public class WalletTransaction {

  /** {@link #reason} values. */
  public static final String TOPUP = "topup";

  public static final String PURCHASE = "purchase";
  public static final String REFUND = "refund";
  public static final String CLAWBACK = "clawback";
  public static final String ADJUSTMENT = "adjustment";

  @Id private String id;

  @Field("wallet_id")
  private String walletId;

  /** Minor units: {@code +topup, -spend, +refund, -clawback}. */
  @Field("delta")
  private long delta;

  @Field("reason")
  private String reason;

  /** The order this ledger row settles/spends against; null for a bare adjustment. */
  @Field("order_id")
  private String orderId;

  /** Top-ups are usable only once this flips true (top-up finality, §5.5). */
  @Field("settled")
  private boolean settled;

  @Field("idempotency_key")
  private String idempotencyKey;

  @Field("created_at")
  private Instant createdAt;

  public WalletTransaction() {}

  public WalletTransaction(
      String id,
      String walletId,
      long delta,
      String reason,
      String orderId,
      boolean settled,
      String idempotencyKey,
      Instant createdAt) {
    this.id = id;
    this.walletId = walletId;
    this.delta = delta;
    this.reason = reason;
    this.orderId = orderId;
    this.settled = settled;
    this.idempotencyKey = idempotencyKey;
    this.createdAt = createdAt;
  }

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getWalletId() {
    return walletId;
  }

  public void setWalletId(String walletId) {
    this.walletId = walletId;
  }

  public long getDelta() {
    return delta;
  }

  public void setDelta(long delta) {
    this.delta = delta;
  }

  public String getReason() {
    return reason;
  }

  public void setReason(String reason) {
    this.reason = reason;
  }

  public String getOrderId() {
    return orderId;
  }

  public void setOrderId(String orderId) {
    this.orderId = orderId;
  }

  public boolean isSettled() {
    return settled;
  }

  public void setSettled(boolean settled) {
    this.settled = settled;
  }

  public String getIdempotencyKey() {
    return idempotencyKey;
  }

  public void setIdempotencyKey(String idempotencyKey) {
    this.idempotencyKey = idempotencyKey;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public void setCreatedAt(Instant createdAt) {
    this.createdAt = createdAt;
  }
}
