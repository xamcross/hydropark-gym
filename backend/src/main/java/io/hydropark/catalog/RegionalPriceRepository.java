package io.hydropark.catalog;

import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface RegionalPriceRepository extends MongoRepository<RegionalPrice, String> {

  /** {@code targetType} is {@code "skill"|"bundle"} - see {@link RegionalPrice}. */
  Optional<RegionalPrice> findByTargetTypeAndTargetIdAndRegion(
      String targetType, String targetId, String region);
}
