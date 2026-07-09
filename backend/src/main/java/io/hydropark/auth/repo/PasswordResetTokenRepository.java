package io.hydropark.auth.repo;

import io.hydropark.auth.domain.PasswordResetToken;
import org.springframework.data.mongodb.repository.MongoRepository;

/** {@code _id} is the SHA-256 token hash, so {@code findById(hash)} is the lookup. */
public interface PasswordResetTokenRepository
    extends MongoRepository<PasswordResetToken, String> {}
