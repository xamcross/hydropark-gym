package io.hydropark.catalog;

import io.hydropark.common.Uuid7;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.2. Polymorphic - <b>no FK</b>: {@code target_type} is {@code "skill"} or {@code "bundle"}
 * (the exact same wire strings as {@link io.hydropark.port.Ports.PurchaseKind#wire()} for those two
 * kinds, deliberately - see {@link PricingPortImpl}). {@code target_id} may point at a nonexistent
 * skill/bundle; Mongo will not stop it, so existence is validated at write time in the service layer
 * (BE §11.2 #3). Unique on {@code (target_type, target_id, region)} via a migration-created index.
 */
@Document(collection = "regional_prices")
public class RegionalPrice {

  @Id private String id = Uuid7.generate();

  @Field("target_type")
  private String targetType;

  @Field("target_id")
  private String targetId;

  /** ISO country / price-tier key. */
  @Field("region")
  private String region;

  /** Minor units. */
  @Field("price")
  private long price;

  @Field("currency")
  private String currency;

  public RegionalPrice() {}

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getTargetType() {
    return targetType;
  }

  public void setTargetType(String targetType) {
    this.targetType = targetType;
  }

  public String getTargetId() {
    return targetId;
  }

  public void setTargetId(String targetId) {
    this.targetId = targetId;
  }

  public String getRegion() {
    return region;
  }

  public void setRegion(String region) {
    this.region = region;
  }

  public long getPrice() {
    return price;
  }

  public void setPrice(long price) {
    this.price = price;
  }

  public String getCurrency() {
    return currency;
  }

  public void setCurrency(String currency) {
    this.currency = currency;
  }
}
