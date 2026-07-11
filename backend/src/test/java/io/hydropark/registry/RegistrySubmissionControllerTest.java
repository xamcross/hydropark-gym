package io.hydropark.registry;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.certification.CertificationReport;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.security.AuthPrincipal;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * P1-20 admin gate: certify is an admin/pipeline op, so {@link RegistrySubmissionController} admits
 * only callers whose {@code users.id} is in {@code hydropark.registry.admin-user-ids} and 403s
 * everyone else — an empty allowlist locks it down for every authenticated caller. Plain JUnit: the
 * controller + {@link RegistryProperties} are built directly and the caller is placed in the
 * {@link SecurityContextHolder} thread-local; no Spring context and no Docker.
 */
class RegistrySubmissionControllerTest {

  private static final JsonNode ANY_MANIFEST = new ObjectMapper().createObjectNode();

  @AfterEach
  void clearContext() {
    SecurityContextHolder.clearContext();
  }

  /** Stub submission service that records whether it was reached and returns a passing report. */
  private static final class RecordingService extends RegistrySubmissionService {
    private boolean called;

    RecordingService() {
      super(null, null); // deps unused: certifySubmission is overridden below
    }

    @Override
    public CertificationReport certifySubmission(JsonNode manifest) {
      called = true;
      return new CertificationReport("skill.test", List.of());
    }
  }

  private static void authenticateAs(String userId) {
    SecurityContextHolder.getContext().setAuthentication(new AuthPrincipal(userId, true));
  }

  private static RegistryProperties allowlist(String... adminIds) {
    RegistryProperties props = new RegistryProperties();
    props.setAdminUserIds(List.of(adminIds));
    return props;
  }

  @Test
  void adminPassesThroughToCertification() {
    RecordingService service = new RecordingService();
    RegistrySubmissionController controller =
        new RegistrySubmissionController(service, allowlist("user-admin"));
    authenticateAs("user-admin");

    ResponseEntity<CertificationReport> res = controller.certify(ANY_MANIFEST);

    assertThat(service.called).as("admin should reach the certification gate").isTrue();
    assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
  }

  @Test
  void nonAdminIsForbiddenAndNeverReachesCertification() {
    RecordingService service = new RecordingService();
    RegistrySubmissionController controller =
        new RegistrySubmissionController(service, allowlist("user-admin"));
    authenticateAs("user-not-admin");

    assertThatThrownBy(() -> controller.certify(ANY_MANIFEST))
        .isInstanceOf(ApiException.class)
        .satisfies(
            e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.FORBIDDEN));
    assertThat(service.called).as("a rejected caller must never hit certification").isFalse();
  }

  @Test
  void emptyAllowlistLocksDownEvenAValidUser() {
    RecordingService service = new RecordingService();
    RegistrySubmissionController controller =
        new RegistrySubmissionController(service, allowlist());
    authenticateAs("some-user");

    assertThatThrownBy(() -> controller.certify(ANY_MANIFEST))
        .isInstanceOf(ApiException.class)
        .satisfies(
            e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.FORBIDDEN));
    assertThat(service.called).isFalse();
  }
}
