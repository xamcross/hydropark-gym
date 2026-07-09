package io.hydropark.wallet;

import io.hydropark.common.CursorPage;
import io.hydropark.wallet.dto.WalletTransactionView;
import io.hydropark.wallet.dto.WalletView;
import io.hydropark.security.CurrentUser;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * BE §4.7 wallet read endpoints. All require a valid access token.
 *
 * <p>This controller is read-only. Neither of the two money-moving wallet flows lives here:
 *
 * <ul>
 *   <li><b>Spend</b> runs via {@code POST /v1/orders/pay-wallet} in {@code commerce}, which forwards
 *       to the settlement worker (the sole price authority) that calls
 *       {@link WalletService#debitForOrder}.
 *   <li><b>Top-up</b> runs via {@code POST /v1/wallet/topup} in {@code commerce}
 *       ({@code WalletTopupController}): a top-up is an {@code orders.kind='wallet_topup'} order that
 *       needs a MoR checkout session, which requires the {@code PaymentProvider} and the
 *       {@code orders} collection - both owned by {@code commerce}, neither importable from
 *       {@code wallet}. Credit lands on the {@code payment.succeeded} webhook and is spendable only
 *       once <b>settled</b> (§5.5).
 * </ul>
 */
@RestController
@RequestMapping("/v1/wallet")
public class WalletController {

  private final WalletService wallet;

  public WalletController(WalletService wallet) {
    this.wallet = wallet;
  }

  @GetMapping
  public WalletView get() {
    String userId = CurrentUser.requireUserId();
    return WalletView.of(wallet.findWallet(userId));
  }

  @GetMapping("/transactions")
  public CursorPage<WalletTransactionView> transactions(
      @RequestParam(required = false) Integer limit,
      @RequestParam(required = false) String cursor) {
    String userId = CurrentUser.requireUserId();
    CursorPage<WalletTransaction> page = wallet.listTransactions(userId, limit, cursor);
    return new CursorPage<>(
        page.items().stream().map(WalletTransactionView::of).toList(), page.nextCursor());
  }
}
