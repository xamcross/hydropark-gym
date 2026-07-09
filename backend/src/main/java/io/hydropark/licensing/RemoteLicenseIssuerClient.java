package io.hydropark.licensing;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.InternalErrors;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.port.Ports.LicenseIssuerPort;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * The remote half of {@link LicenseIssuerPort} (BACKEND-DESIGN §2 trust zones). Loaded when
 * {@code hydropark.issuer.enabled=false} - i.e. in the api zone, which must never hold the signing
 * keys. It forwards to the issuer zone's {@code /internal/licenses/issue} over the internal network
 * using the shared {@code internalRestClient}.
 *
 * <p>This is a <b>network boundary, not a permission</b> (§6.2 N3). The api zone holding the internal
 * token can call the Issuer, but the Issuer independently re-verifies settlement for the exact
 * {@code (user, skill)} on every call, so this client cannot be used as a signing oracle for an
 * unowned skill.
 */
@Component
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "false")
public class RemoteLicenseIssuerClient implements LicenseIssuerPort {

  private final RestClient internal;
  private final String issuerBaseUrl;
  private final ObjectMapper mapper;

  public RemoteLicenseIssuerClient(
      @Qualifier("internalRestClient") RestClient internal,
      @Value("${hydropark.internal.issuer-url:}") String issuerBaseUrl,
      ObjectMapper mapper) {
    this.internal = internal;
    this.issuerBaseUrl = issuerBaseUrl;
    this.mapper = mapper;
  }

  @Override
  public IssuedLicense issue(String userId, String skillId, String deviceId) {
    IssuedLicense issued =
        internal
            .post()
            .uri(issuerBaseUrl + "/internal/licenses/issue")
            .contentType(MediaType.APPLICATION_JSON)
            .body(new InternalIssueRequest(userId, skillId, deviceId))
            .retrieve()
            // The Issuer's refusals are domain answers, not transport faults. Without this, its
            // deliberate `403 not_entitled` surfaces to the caller as `500 internal_error`.
            .onStatus(HttpStatusCode::isError, (req, res) -> InternalErrors.rethrow(res, mapper, "issuer"))
            .body(IssuedLicense.class);

    if (issued == null) {
      throw new ApiException(ErrorCode.INTERNAL_ERROR, "empty issuer response");
    }
    return issued;
  }
}
