package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.auth.domain.StepUpChallenge;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.OAuthIdentityRepository;
import io.hydropark.auth.repo.StepUpChallengeRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.AuthEmailSender;
import io.hydropark.auth.service.OAuthTokenVerifier;
import io.hydropark.auth.service.StepUpService;
import io.hydropark.auth.support.StepUpActions;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.UpdateDefinition;

/**
 * §8 (SF11/N8) trust-on-first-use. TOFU is anchored on {@code has_ever_had_device}: it is granted
 * exactly once (the atomic false-&gt;true claim matches), and refused forever after - even from an
 * empty device set - so the deauth-all-then-TOFU trust-root takeover is closed.
 */
class StepUpServiceTest {

  private StepUpChallengeRepository challenges;
  private UserRepository users;
  private MongoTemplate mongo;
  private StepUpService service;

  @BeforeEach
  void setUp() {
    challenges = mock(StepUpChallengeRepository.class);
    users = mock(UserRepository.class);
    OAuthIdentityRepository identities = mock(OAuthIdentityRepository.class);
    OAuthTokenVerifier verifier = mock(OAuthTokenVerifier.class);
    mongo = mock(MongoTemplate.class);
    AuthEmailSender email = mock(AuthEmailSender.class);
    service =
        new StepUpService(
            challenges, users, identities, verifier, mongo, new AppProperties(), email);
  }

  @Test
  void tofuIsRefusedWithoutProofOnceTheAccountHasEverHadADevice() {
    // The atomic claim matches only while has_ever_had_device is false; here it is already true.
    when(mongo.findAndModify(any(Query.class), any(UpdateDefinition.class), eq(User.class)))
        .thenReturn(null);

    assertThatThrownBy(
            () -> service.assertStepUp("u1", null, StepUpActions.DEVICE_REGISTER))
        .isInstanceOf(ApiException.class)
        .satisfies(
            e ->
                assertThat(((ApiException) e).errorCode())
                    .isEqualTo(ErrorCode.STEP_UP_REQUIRED));

    // With no proof, we never even look for a challenge to consume.
    verify(mongo, never())
        .findAndModify(any(Query.class), any(UpdateDefinition.class), eq(StepUpChallenge.class));
  }

  @Test
  void tofuIsGrantedForTheGenuineFirstDeviceBind() {
    // The claim flips has_ever_had_device false->true and returns the row: first device ever.
    when(mongo.findAndModify(any(Query.class), any(UpdateDefinition.class), eq(User.class)))
        .thenReturn(new User("u1", null, null, null, Instant.now()));

    assertThatCode(() -> service.assertStepUp("u1", null, StepUpActions.DEVICE_REGISTER))
        .doesNotThrowAnyException();
  }
}
