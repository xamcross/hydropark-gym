package io.hydropark.catalog;

import io.hydropark.catalog.dto.BundleDetailDto;
import io.hydropark.catalog.dto.CatalogItemDto;
import io.hydropark.catalog.dto.PreviewDto;
import io.hydropark.catalog.dto.SkillDetailDto;
import io.hydropark.catalog.dto.SkillVersionDto;
import io.hydropark.common.CursorPage;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * BE §4.2. Every route here is registered {@code permitAll} for GET in {@code SecurityConfig}
 * (optional auth): an anonymous caller gets the catalog, an authed one additionally gets {@code
 * owned} (via {@link CatalogService} reading {@link io.hydropark.security.CurrentUser#orNull()}).
 */
@RestController
@RequestMapping("/v1/catalog")
public class CatalogController {

  private final CatalogService catalog;

  public CatalogController(CatalogService catalog) {
    this.catalog = catalog;
  }

  @GetMapping
  public CursorPage<CatalogItemDto> list(
      @RequestParam(required = false) Integer limit,
      @RequestParam(required = false) String cursor,
      @RequestParam(required = false) String region) {
    return catalog.listCatalog(limit, cursor, region);
  }

  @GetMapping("/skills/{skillId}")
  public SkillDetailDto skillDetail(
      @PathVariable String skillId, @RequestParam(required = false) String region) {
    return catalog.getSkillDetail(skillId, region);
  }

  @GetMapping("/skills/{skillId}/versions")
  public CursorPage<SkillVersionDto> skillVersions(
      @PathVariable String skillId,
      @RequestParam(required = false) Integer limit,
      @RequestParam(required = false) String cursor) {
    return catalog.listVersions(skillId, limit, cursor);
  }

  @GetMapping("/bundles/{bundleId}")
  public BundleDetailDto bundleDetail(
      @PathVariable String bundleId, @RequestParam(required = false) String region) {
    return catalog.getBundleDetail(bundleId, region);
  }

  /**
   * Extraction-hardened (BE §4.2 N1): deliberately takes <b>no</b> request parameter besides the
   * path variable. Never add one - a client-supplied prompt here would turn this into a free
   * inference oracle over the paid persona (SF8).
   */
  @GetMapping("/skills/{skillId}/preview")
  public PreviewDto preview(@PathVariable String skillId) {
    return catalog.getPreview(skillId);
  }
}
