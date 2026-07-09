package io.hydropark.commerce;

import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.SettlementPort;
import io.hydropark.port.Ports.WalletPurchaseResult;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The in-process {@link SettlementPort} - loaded in the worker zone ({@code hydropark.worker.enabled=
 * true}) and in single-JVM dev, where the api tier calls the worker directly. Delegates straight to
 * {@link SettlementService}, the sole price authority (§5.4).
 */
@Component
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
public class LocalSettlementPort implements SettlementPort {

  private final SettlementService settlement;

  public LocalSettlementPort(SettlementService settlement) {
    this.settlement = settlement;
  }

  @Override
  public WalletPurchaseResult payWithWallet(
      String userId, PurchaseKind kind, String targetId, String region, String idempotencyKey) {
    return settlement.payWithWallet(userId, kind, targetId, region, idempotencyKey);
  }
}
