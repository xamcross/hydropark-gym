package io.hydropark.wallet;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.5 / §26.1 - a prepaid credit account. One per user ({@code user_id} unique).
 *
 * <p><b>{@link #balance} is a materialized cache</b> of the settled ledger sum, not the source of
 * truth ({@link WalletTransaction} is). Two invariants ride on it:
 *
 * <ol>
 *   <li>It may go <b>negative</b> - and is <b>never clamped</b>. A top-up chargeback clawback drives
 *       it below zero on purpose (§3.5 drops the {@code CHECK(balance>=0)} that would abort the
 *       clawback). The overdraft guard on <em>spend</em> lives in the atomic conditional debit
 *       ({@code balance >= price}), never in a stored constraint.
 *   <li>It reflects only <b>settled</b> credit. An unsettled top-up sits in the ledger with {@code
 *       settled=false} and does not advance this field until finality (§5.5).
 * </ol>
 *
 * <p>{@link #currency} is fixed at first top-up; the wallet funds only same-currency purchases
 * (cross-currency -> {@code WALLET_CURRENCY_MISMATCH}). {@link #status} freezes after a top-up
 * chargeback and blocks further spend.
 */
@Document(collection = "wallet_accounts")
public class WalletAccount {

  public static final String ACTIVE = "active";
  public static final String FROZEN = "frozen";

  @Id private String id;

  @Field("user_id")
  private String userId;

  /** Minor units. May be negative (clawback). Cache of the settled ledger sum. */
  @Field("balance")
  private long balance;

  @Field("status")
  private String status;

  /** ISO-4217; fixed at first top-up. */
  @Field("currency")
  private String currency;

  /** Set after a top-up chargeback for anti-fraud review (SF10). */
  @Field("flagged")
  private boolean flagged;

  @Field("created_at")
  private Instant createdAt;

  @Field("updated_at")
  private Instant updatedAt;

  public WalletAccount() {}

  public WalletAccount(
      String id, String userId, long balance, String status, String currency, Instant now) {
    this.id = id;
    this.userId = userId;
    this.balance = balance;
    this.status = status;
    this.currency = currency;
    this.flagged = false;
    this.createdAt = now;
    this.updatedAt = now;
  }

  public boolean isActive() {
    return ACTIVE.equals(status);
  }

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getUserId() {
    return userId;
  }

  public void setUserId(String userId) {
    this.userId = userId;
  }

  public long getBalance() {
    return balance;
  }

  public void setBalance(long balance) {
    this.balance = balance;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public String getCurrency() {
    return currency;
  }

  public void setCurrency(String currency) {
    this.currency = currency;
  }

  public boolean isFlagged() {
    return flagged;
  }

  public void setFlagged(boolean flagged) {
    this.flagged = flagged;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public void setCreatedAt(Instant createdAt) {
    this.createdAt = createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }
}
