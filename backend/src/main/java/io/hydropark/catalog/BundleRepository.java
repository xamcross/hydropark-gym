package io.hydropark.catalog;

import org.springframework.data.mongodb.repository.MongoRepository;

/** Point lookups only - list/cursor queries go through {@link CatalogService}'s MongoTemplate use. */
public interface BundleRepository extends MongoRepository<Bundle, String> {}
