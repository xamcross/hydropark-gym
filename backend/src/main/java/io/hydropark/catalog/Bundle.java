package io.hydropark.catalog;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/** BE §3.2. {@code _id} is a human slug ({@code home-starter-pack}), like {@link Skill#getId()}. */
@Document(collection = "bundles")
public class Bundle {

  @Id private String id;

  @Field("name")
  private String name;

  /** Minor units; < sum(member base prices) by content-authoring convention, not enforced here. */
  @Field("bundle_price")
  private long bundlePrice;

  @Field("base_currency")
  private String baseCurrency;

  /** {@link CatalogStatus#wire()} value. */
  @Field("status")
  private String status;

  public Bundle() {}

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

  public long getBundlePrice() {
    return bundlePrice;
  }

  public void setBundlePrice(long bundlePrice) {
    this.bundlePrice = bundlePrice;
  }

  public String getBaseCurrency() {
    return baseCurrency;
  }

  public void setBaseCurrency(String baseCurrency) {
    this.baseCurrency = baseCurrency;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }
}
