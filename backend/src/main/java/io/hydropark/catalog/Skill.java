package io.hydropark.catalog;

import java.time.Instant;
import java.util.List;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.2. {@code _id} is the human slug ({@code cooking-assistant}), never a UUID.
 *
 * <p><b>{@code system_prompt} must never appear on this document.</b> The full persona is paid IP
 * and lives only inside the signed {@code .hpskill} package (SF8) - do not add it "for later".
 * {@link #compressedPrompt} is the only persona text this service ever serves pre-purchase.
 */
@Document(collection = "skills")
public class Skill {

  @Id private String id;

  @Field("name")
  private String name;

  @Field("category")
  private String category;

  @Field("is_free")
  private boolean free;

  /** {@link CatalogStatus#wire()} value. */
  @Field("status")
  private String status;

  /** Minor units (BE §11). */
  @Field("base_price")
  private long basePrice;

  @Field("base_currency")
  private String baseCurrency;

  /** The ONLY persona text served pre-purchase (SF8). Never the full system_prompt. */
  @Field("compressed_prompt")
  private String compressedPrompt;

  @Field("preview_transcript_uri")
  private String previewTranscriptUri;

  @Field("min_model_tier")
  private String minModelTier;

  /**
   * The manifest's top-level {@code capabilities} token array (F05) - the v1 closed set (e.g.
   * {@code "timers"}, {@code "unit_conversion"}, {@code "list_management"}, {@code "calculation"},
   * {@code "date_math"}). This is the install-time capability-disclosure source (SPEC §8.5/§11);
   * distinct from {@code tools}, which this document never carries.
   */
  @Field("capabilities")
  private List<String> capabilities;

  @Field("created_at")
  private Instant createdAt;

  @Field("updated_at")
  private Instant updatedAt;

  public Skill() {}

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getName() {
    return name;
  }

  public void setName(String name) {
    this.name = name;
  }

  public String getCategory() {
    return category;
  }

  public void setCategory(String category) {
    this.category = category;
  }

  public boolean isFree() {
    return free;
  }

  public void setFree(boolean free) {
    this.free = free;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public long getBasePrice() {
    return basePrice;
  }

  public void setBasePrice(long basePrice) {
    this.basePrice = basePrice;
  }

  public String getBaseCurrency() {
    return baseCurrency;
  }

  public void setBaseCurrency(String baseCurrency) {
    this.baseCurrency = baseCurrency;
  }

  public String getCompressedPrompt() {
    return compressedPrompt;
  }

  public void setCompressedPrompt(String compressedPrompt) {
    this.compressedPrompt = compressedPrompt;
  }

  public String getPreviewTranscriptUri() {
    return previewTranscriptUri;
  }

  public void setPreviewTranscriptUri(String previewTranscriptUri) {
    this.previewTranscriptUri = previewTranscriptUri;
  }

  public String getMinModelTier() {
    return minModelTier;
  }

  public void setMinModelTier(String minModelTier) {
    this.minModelTier = minModelTier;
  }

  public List<String> getCapabilities() {
    return capabilities;
  }

  public void setCapabilities(List<String> capabilities) {
    this.capabilities = capabilities;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public void setCreatedAt(Instant createdAt) {
    this.createdAt = createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }
}
