package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.port.Ports.WalletPurchaseResult;
import java.util.List;

/** §4.3 pay-wallet response: the created order and the skills it granted. */
public record WalletPurchaseResponse(
    @JsonProperty("order_id") String orderId, @JsonProperty("owned") List<String> owned) {

  public static WalletPurchaseResponse of(WalletPurchaseResult r) {
    return new WalletPurchaseResponse(r.orderId(), r.ownedSkillIds());
  }
}
