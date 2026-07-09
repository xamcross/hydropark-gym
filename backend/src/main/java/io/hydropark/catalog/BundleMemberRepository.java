package io.hydropark.catalog;

import java.util.List;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface BundleMemberRepository extends MongoRepository<BundleMember, String> {

  List<BundleMember> findByBundleId(String bundleId);
}
