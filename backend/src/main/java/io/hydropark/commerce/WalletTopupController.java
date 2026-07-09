package io.hydropark.commerce;

import io.hydropark.security.AuthPrincipal;
import io.hydropark.security.CurrentUser;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * §4.7 {@code POST /v1/wallet/topup}. A top-up is an {@code orders.kind='wallet_topup'} order that
 * needs a MoR checkout session, so it lives here in {@code commerce} - which owns
 * {@link PaymentProvider} and the {@code orders} collection - not in {@code wallet}, which holds
 * neither and must not import them. The {@code wallet} package keeps only the read side
 * ({@code GET /v1/wallet}, {@code GET /v1/wallet/transactions}).
 *
 * <p>Loaded only in the api zone (the public checkout surface), mirroring {@link OrderController}.
 * Honours {@code Idempotency-Key} (Appendix A) exactly as {@code /orders/checkout} does.
 */
@RestController
@RequestMapping("/v1/wallet")
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class WalletTopupController {

  private final OrderService orders;
  private final IdempotencyService idempotency;

  public WalletTopupController(OrderService orders, IdempotencyService idempotency) {
    this.orders = orders;
    this.idempotency = idempotency;
  }

  @PostMapping("/topup")
  public ResponseEntity<Object> topup(
      @RequestBody TopupRequest req,
      @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
    AuthPrincipal p = CurrentUser.require();
    return idempotency.execute(
        p.userId(),
        "wallet/topup",
        idempotencyKey,
        HttpStatus.OK,
        () -> orders.topup(p.userId(), p.emailVerified(), req, idempotencyKey));
  }
}
