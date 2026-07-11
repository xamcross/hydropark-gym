package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.security.AuthPrincipal;
import java.time.Instant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * The controller's auth contract (P1-19): the model route serves an anonymous caller, the skill route
 * demands an authenticated one and forwards its {@code users.id}. Plain JUnit - the service is mocked
 * and the caller is placed in the {@link SecurityContextHolder} thread-local; no Spring, no Docker.
 */
class DownloadControllerTest {

  private final DownloadService service = mock(DownloadService.class);
  private final DownloadController controller = new DownloadController(service);

  @AfterEach
  void clearContext() {
    SecurityContextHolder.clearContext();
  }

  private static void authenticateAs(String userId) {
    SecurityContextHolder.getContext().setAuthentication(new AuthPrincipal(userId, true));
  }

  @Test
  void modelDownloadIsServedToAnAnonymousCaller() {
    SecurityContextHolder.clearContext(); // no principal
    when(service.issueModelDownload("qwen"))
        .thenReturn(new ModelDownloadResponse("https://cdn/qwen.gguf", Instant.now().plusSeconds(3600)));

    ModelDownloadResponse res = controller.model("qwen");

    assertThat(res.url()).isEqualTo("https://cdn/qwen.gguf");
    verify(service).issueModelDownload("qwen");
  }

  @Test
  void skillDownloadRequiresAnAuthenticatedUser() {
    SecurityContextHolder.clearContext(); // anonymous

    assertThatThrownBy(() -> controller.skill("cooking", "1.0.0"))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.UNAUTHORIZED));
    verify(service, never()).issueSkillDownload(any(), any(), any());
  }

  @Test
  void authenticatedSkillDownloadForwardsTheCallersUserId() {
    authenticateAs("u1");
    when(service.issueSkillDownload("u1", "cooking", "1.0.0"))
        .thenReturn(
            new SkillDownloadResponse(
                "https://cdn/cooking.hpskill", Instant.now().plusSeconds(300), "wm-token"));

    SkillDownloadResponse res = controller.skill("cooking", "1.0.0");

    assertThat(res.watermark()).isEqualTo("wm-token");
    verify(service).issueSkillDownload("u1", "cooking", "1.0.0");
  }
}
