package io.hydropark.continuity;

import org.springframework.data.mongodb.repository.MongoRepository;

/** Spring Data access for {@code continuity_batches} (P1-23.1). */
public interface ContinuityBatchRepository extends MongoRepository<ContinuityBatch, String> {}
