package io.hydropark.commerce;

import io.hydropark.common.ApiException;
import io.hydropark.common.CursorPage;
import io.hydropark.security.AuthPrincipal;
import io.hydropark.security.CurrentUser;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * §4.3 - the public order endpoints. Loaded only in the api zone. Pricing is server-derived; the
 * wallet path forwards no price. Mutating calls honour {@code Idempotency-Key} (Appendix A).
 */
@RestController
@RequestMapping("/v1/orders")
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class OrderController {

  private final OrderService orders;
  private final IdempotencyService idempotency;

  public OrderController(OrderService orders, IdempotencyService idempotency) {
    this.orders = orders;
    this.idempotency = idempotency;
  }

  @PostMapping("/checkout")
  public ResponseEntity<Object> checkout(
      @RequestBody CheckoutRequest req,
      @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
    AuthPrincipal p = CurrentUser.require();
    return idempotency.execute(
        p.userId(),
        "orders/checkout",
        idempotencyKey,
        HttpStatus.OK,
        () -> orders.checkout(p.userId(), p.emailVerified(), req, idempotencyKey));
  }

  @PostMapping("/pay-wallet")
  public ResponseEntity<Object> payWallet(
      @RequestBody PayWalletRequest req,
      @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
    AuthPrincipal p = CurrentUser.require();
    if (idempotencyKey == null || idempotencyKey.isBlank()) {
      throw ApiException.validation("Idempotency-Key header is required for pay-wallet");
    }
    return idempotency.execute(
        p.userId(),
        "orders/pay-wallet",
        idempotencyKey,
        HttpStatus.OK,
        () -> orders.payWallet(p.userId(), p.emailVerified(), req, idempotencyKey));
  }

  @GetMapping("/{orderId}")
  public OrderView get(@PathVariable String orderId) {
    return orders.getOrder(CurrentUser.requireUserId(), orderId);
  }

  @GetMapping
  public CursorPage<OrderView> list(
      @RequestParam(required = false) String cursor,
      @RequestParam(required = false) Integer limit) {
    return orders.listOrders(CurrentUser.requireUserId(), cursor, limit);
  }
}
