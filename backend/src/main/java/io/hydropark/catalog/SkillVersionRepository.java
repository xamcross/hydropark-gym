package io.hydropark.catalog;

import java.util.List;
import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface SkillVersionRepository extends MongoRepository<SkillVersion, String> {

  /** Resolves "latest" - {@code is_current} is authoritative because semver isn't sortable. */
  Optional<SkillVersion> findBySkillIdAndCurrentTrue(String skillId);

  /** Batch form for catalog listing pages - avoids one query per row. */
  List<SkillVersion> findBySkillIdInAndCurrentTrue(List<String> skillIds);
}
