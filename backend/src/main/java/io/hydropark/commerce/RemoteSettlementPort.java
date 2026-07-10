package io.hydropark.commerce;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.ApiError;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.SettlementPort;
import io.hydropark.port.Ports.WalletPurchaseResult;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * The remote {@link SettlementPort} - loaded in an api-only zone ({@code hydropark.worker.enabled=
 * false}), where the settlement worker runs in a separate container with no public ingress. It POSTs
 * to {@code /internal/settlement/pay-wallet} over the {@code internalRestClient} (which carries the
 * {@code X-Internal-Token}). Isolation is not authorization: this is a network boundary, and the
 * worker still derives the price and re-checks everything itself (§6.2 N3).
 *
 * <p>Worker-side error semantics (402 insufficient_balance, 409 wallet_currency_mismatch, ...) are
 * reconstructed from the {@link ApiError} body so the client sees the same typed error it would on a
 * single-JVM deployment.
 */
@Component
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "false")
public class RemoteSettlementPort implements SettlementPort {

  private final RestClient internal;
  private final ObjectMapper mapper;
  private final String workerUrl;

  public RemoteSettlementPort(
      @Qualifier("internalRestClient") RestClient internal,
      ObjectMapper mapper,
      @Value("${hydropark.internal.worker-url:}") String workerUrl) {
    this.internal = internal;
    this.mapper = mapper;
    this.workerUrl = workerUrl;
  }

  @Override
  public WalletPurchaseResult payWithWallet(
      String userId, PurchaseKind kind, String targetId, String region, String idempotencyKey) {
    InternalPayWalletRequest body =
        new InternalPayWalletRequest(userId, kind.wire(), targetId, region, idempotencyKey);

    // Retried on transport failure only. Safe because the debit is keyed by
    // wallet_transactions.idempotency_key (unique index): a replayed request cannot debit twice.
    // The worker does not scale to zero, so this should be rare - but a machine restart during a
    // deploy looks exactly like a cold wake to the caller.
    WalletPurchaseResponse resp =
        io.hydropark.common.InternalRetry.call(
            "settlement worker",
            () ->
                internal
                    .post()
                    .uri(workerUrl + "/internal/settlement/pay-wallet")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .onStatus(HttpStatusCode::isError, (req, res) -> translateError(res))
                    .body(WalletPurchaseResponse.class));

    if (resp == null) {
      throw new ApiException(ErrorCode.INTERNAL_ERROR, "empty settlement response");
    }
    return new WalletPurchaseResult(resp.orderId(), resp.owned());
  }

  /**
   * Delegates to the shared translator. This used to be a private copy; the identical logic also
   * existed (and was missing) in the licensing client. Cross-zone contracts get exactly one
   * implementation - see {@code Ports.StepUpActions} for what happens when they get two.
   */
  private void translateError(org.springframework.http.client.ClientHttpResponse res)
      throws java.io.IOException {
    io.hydropark.common.InternalErrors.rethrow(res, mapper, "settlement worker");
  }

  private static ErrorCode codeFor(String wire) {
    for (ErrorCode c : ErrorCode.values()) {
      if (c.code().equals(wire)) {
        return c;
      }
    }
    return ErrorCode.INTERNAL_ERROR;
  }
}
