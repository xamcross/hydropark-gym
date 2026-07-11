package io.hydropark.download;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Content-delivery config under {@code hydropark.blobstore.*}. {@code provider} selects the active
 * {@link BlobStore} adapter ({@code local} by default; {@code r2} once creds land).
 *
 * <p>Binds via {@code @Component} for the same reason {@link
 * io.hydropark.registry.RegistryProperties} does: the application enables config properties
 * explicitly ({@code @EnableConfigurationProperties}) rather than scanning, so a standalone
 * {@code @ConfigurationProperties} class registers itself as a component.
 *
 * <p>The {@code hmacSecret} default is a loud dev placeholder - the signing key must be supplied out
 * of band ({@code HP_BLOBSTORE_HMAC_SECRET}) in any deployed zone, exactly like every other secret.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.blobstore")
public class BlobStoreProperties {

  /** {@code local} | {@code r2}. Drives which {@link BlobStore} bean is active. */
  private String provider = "local";

  /** URL prefix the signed object path is appended to (the CDN / bucket public endpoint). */
  private String baseUrl = "http://localhost:8080/blobs";

  /** Keys the {@link LocalFsBlobStore} HMAC and the buyer-watermark token. Never a real secret's default. */
  private String hmacSecret = "dev-insecure-blobstore-secret-change-me";

  /** Paid {@code .hpskill} URLs are short-lived and user-scoped (SF8). */
  private Duration skillUrlTtl = Duration.ofMinutes(5);

  /** The free base-model GGUF URL is long-lived and shared so the CDN can cache it (P1-19.3). */
  private Duration modelUrlTtl = Duration.ofHours(24);

  /**
   * Declared model object size, for the egress meter (P1-19.4). The dev store serves no real bytes,
   * so there is nothing to weigh; a deployed model CDN reconciles true billed egress from its own
   * access logs. Left 0 by default rather than fabricating a number.
   */
  private long modelBytesEstimate = 0L;

  public String getProvider() {
    return provider;
  }

  public void setProvider(String provider) {
    this.provider = provider;
  }

  public String getBaseUrl() {
    return baseUrl;
  }

  public void setBaseUrl(String baseUrl) {
    this.baseUrl = baseUrl;
  }

  public String getHmacSecret() {
    return hmacSecret;
  }

  public void setHmacSecret(String hmacSecret) {
    this.hmacSecret = hmacSecret;
  }

  public Duration getSkillUrlTtl() {
    return skillUrlTtl;
  }

  public void setSkillUrlTtl(Duration skillUrlTtl) {
    this.skillUrlTtl = skillUrlTtl;
  }

  public Duration getModelUrlTtl() {
    return modelUrlTtl;
  }

  public void setModelUrlTtl(Duration modelUrlTtl) {
    this.modelUrlTtl = modelUrlTtl;
  }

  public long getModelBytesEstimate() {
    return modelBytesEstimate;
  }

  public void setModelBytesEstimate(long modelBytesEstimate) {
    this.modelBytesEstimate = modelBytesEstimate;
  }
}
