package io.hydropark.commerce;

import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.WalletPurchaseResult;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * §5.4 - the worker-zone half of {@link io.hydropark.port.Ports.SettlementPort}. Reachable only under
 * {@code /internal/**}, already guarded by {@code InternalAuthFilter} + constant-time token compare;
 * the hosting worker app takes no public ingress. The api tier's {@link RemoteSettlementPort} calls
 * here when the zones run as separate containers.
 *
 * <p>It receives {@code (user, kind, target, region)} and never a price - the worker derives the
 * amount itself. Any {@code ApiException} thrown by settlement (insufficient balance, frozen wallet,
 * currency mismatch) is rendered by the global handler and reconstructed on the caller side.
 */
@RestController
@RequestMapping("/internal/settlement")
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
public class InternalSettlementController {

  private final SettlementService settlement;

  public InternalSettlementController(SettlementService settlement) {
    this.settlement = settlement;
  }

  @PostMapping("/pay-wallet")
  public WalletPurchaseResponse payWallet(@RequestBody InternalPayWalletRequest req) {
    WalletPurchaseResult r =
        settlement.payWithWallet(
            req.userId(),
            PurchaseKind.fromWire(req.kind()),
            req.targetId(),
            req.region(),
            req.idempotencyKey());
    return WalletPurchaseResponse.of(r);
  }
}
