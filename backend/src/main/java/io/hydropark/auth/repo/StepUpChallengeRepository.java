package io.hydropark.auth.repo;

import io.hydropark.auth.domain.StepUpChallenge;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface StepUpChallengeRepository extends MongoRepository<StepUpChallenge, String> {}
