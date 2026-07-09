package io.hydropark.wallet.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.wallet.WalletTransaction;
import java.time.Instant;

/** BE §4.7 - one ledger row in {@code GET /v1/wallet/transactions}. */
public record WalletTransactionView(
    String id,
    long delta,
    String reason,
    @JsonProperty("order_id") String orderId,
    boolean settled,
    @JsonProperty("created_at") Instant createdAt) {

  public static WalletTransactionView of(WalletTransaction t) {
    return new WalletTransactionView(
        t.getId(), t.getDelta(), t.getReason(), t.getOrderId(), t.isSettled(), t.getCreatedAt());
  }
}
