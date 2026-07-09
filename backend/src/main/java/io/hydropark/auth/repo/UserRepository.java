package io.hydropark.auth.repo;

import io.hydropark.auth.domain.User;
import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface UserRepository extends MongoRepository<User, String> {

  /** Email is stored normalised to lower-case, so a plain equality lookup is case-insensitive. */
  Optional<User> findByEmail(String email);

  boolean existsByEmail(String email);

  Optional<User> findByDeletionJobId(String deletionJobId);
}
