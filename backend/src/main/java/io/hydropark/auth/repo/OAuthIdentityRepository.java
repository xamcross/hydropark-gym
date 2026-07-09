package io.hydropark.auth.repo;

import io.hydropark.auth.domain.OAuthIdentity;
import java.util.List;
import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface OAuthIdentityRepository extends MongoRepository<OAuthIdentity, String> {

  Optional<OAuthIdentity> findByProviderAndProviderSub(String provider, String providerSub);

  List<OAuthIdentity> findByUserId(String userId);

  boolean existsByUserId(String userId);
}
