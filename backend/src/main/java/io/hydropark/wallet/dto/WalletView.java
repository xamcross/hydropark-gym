package io.hydropark.wallet.dto;

import io.hydropark.wallet.WalletAccount;

/**
 * BE §4.7 - {@code GET /v1/wallet} response {@code {balance, currency, status}}. A user with no
 * wallet yet reads as a zero balance with an unset currency (the currency is fixed on first top-up).
 */
public record WalletView(long balance, String currency, String status) {

  public static WalletView of(WalletAccount w) {
    if (w == null) {
      return new WalletView(0L, null, WalletAccount.ACTIVE);
    }
    return new WalletView(w.getBalance(), w.getCurrency(), w.getStatus());
  }
}
