package io.hydropark.auth.repo;

import io.hydropark.auth.domain.RefreshToken;
import java.util.List;
import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface RefreshTokenRepository extends MongoRepository<RefreshToken, String> {

  Optional<RefreshToken> findByTokenHash(String tokenHash);

  /** A live child proves the presented row legitimately rotated (grace vs. out-of-chain reuse). */
  boolean existsByPrevIdAndRevokedFalse(String prevId);

  /** Current family tip(s): unused and un-revoked, newest first (UUIDv7 ids are time-sortable). */
  List<RefreshToken> findByFamilyIdAndUsedAtIsNullAndRevokedFalseOrderByIdDesc(String familyId);
}
