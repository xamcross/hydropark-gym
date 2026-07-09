package io.hydropark.commerce;

import io.hydropark.common.ApiException;

/** §3.3 orders.payment_source. */
public enum PaymentSource {
  MOR("mor"),
  WALLET("wallet");

  private final String wire;

  PaymentSource(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }

  public static PaymentSource fromWire(String s) {
    for (PaymentSource v : values()) {
      if (v.wire.equals(s)) {
        return v;
      }
    }
    throw ApiException.validation("unknown payment_source: " + s);
  }
}
