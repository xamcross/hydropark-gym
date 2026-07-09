package io.hydropark.catalog;

import io.hydropark.common.Uuid7;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.2: composite identity {@code (bundle_id, skill_id)}. Mongo has no native composite {@code
 * _id} short of an embedded document, so - consistent with every other collection in this schema -
 * this document carries its own UUIDv7 {@code _id} and relies on a migration-created <b>unique
 * compound index on {@code (bundle_id, skill_id)}</b> to enforce the composite-identity constraint
 * (mirrors how {@code skill_versions} enforces {@code (skill_id, version)} uniqueness alongside its
 * own UUIDv7 id).
 */
@Document(collection = "bundle_members")
public class BundleMember {

  @Id private String id = Uuid7.generate();

  @Field("bundle_id")
  private String bundleId;

  @Field("skill_id")
  private String skillId;

  public BundleMember() {}

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getBundleId() {
    return bundleId;
  }

  public void setBundleId(String bundleId) {
    this.bundleId = bundleId;
  }

  public String getSkillId() {
    return skillId;
  }

  public void setSkillId(String skillId) {
    this.skillId = skillId;
  }
}
