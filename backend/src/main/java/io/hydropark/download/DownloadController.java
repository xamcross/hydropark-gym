package io.hydropark.download;

import io.hydropark.security.CurrentUser;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Content delivery (P1-19). Two shapes gated differently in {@code SecurityConfig}:
 *
 * <ul>
 *   <li><b>{@code GET /skills/{skillId}/{version}}</b> - authenticated; issues a short-TTL,
 *       user-scoped signed URL only for a free skill or an active grant, and records a watermark
 *       buyer-token (P1-19.2).
 *   <li><b>{@code GET /models/{modelId}}</b> - public; a free, cacheable signed URL for the base
 *       model, no entitlement (P1-19.3).
 * </ul>
 */
@RestController
@RequestMapping("/v1/download")
public class DownloadController {

  private final DownloadService downloads;

  public DownloadController(DownloadService downloads) {
    this.downloads = downloads;
  }

  @GetMapping("/skills/{skillId}/{version}")
  public SkillDownloadResponse skill(
      @PathVariable String skillId, @PathVariable String version) {
    String userId = CurrentUser.requireUserId();
    return downloads.issueSkillDownload(userId, skillId, version);
  }

  @GetMapping("/models/{modelId}")
  public ModelDownloadResponse model(@PathVariable String modelId) {
    return downloads.issueModelDownload(modelId);
  }
}
