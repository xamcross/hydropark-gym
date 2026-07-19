package io.hydropark.registry;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * The registry admin allowlist, under {@code hydropark.registry.*}. Skill submission (POST
 * {@code /v1/registry/skills:certify}) is an admin/pipeline operation, not an end-user desktop route:
 * {@code SecurityConfig} only guarantees a valid access token, so the controller additionally requires
 * that the caller's {@code users.id} appear in {@link #adminUserIds} and 403s everyone else.
 *
 * <p>Deliberately minimal — a config-driven allowlist, not a role framework. The <b>default is
 * empty</b>, which locks the endpoint down entirely (no one may submit) until an operator explicitly
 * names admins via {@code HP_REGISTRY_ADMIN_USER_IDS} (comma-separated).
 *
 * <p>Binds via {@code @Component} for the same reason {@code PackageSigningProperties} does: the
 * application enables config properties explicitly ({@code @EnableConfigurationProperties}) rather than
 * scanning, so a standalone {@code @ConfigurationProperties} class registers itself as a component.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.registry")
public class RegistryProperties {

  /**
   * The {@code users.id}s permitted to submit skills. Empty by default = locked down. Populated from
   * {@code HP_REGISTRY_ADMIN_USER_IDS} (comma-separated); never a wildcard.
   */
  private List<String> adminUserIds = new ArrayList<>();

  public List<String> getAdminUserIds() {
    return adminUserIds;
  }

  public void setAdminUserIds(List<String> adminUserIds) {
    this.adminUserIds = adminUserIds == null ? new ArrayList<>() : adminUserIds;
  }

  /** True iff {@code userId} is a configured registry admin. An empty allowlist always returns false. */
  public boolean isAdmin(String userId) {
    return userId != null && adminUserIds.contains(userId);
  }
}
