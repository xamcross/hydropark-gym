package io.hydropark.auth.service;

import static org.springframework.data.mongodb.core.query.Criteria.where;
import static org.springframework.data.mongodb.core.query.Query.query;

import io.hydropark.auth.domain.StepUpChallenge;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.OAuthIdentityRepository;
import io.hydropark.auth.repo.StepUpChallengeRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.OAuthTokenVerifier.VerifiedIdentity;
import io.hydropark.auth.support.StepUpActions;
import io.hydropark.auth.support.Tokens;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports;
import java.time.Instant;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

/**
 * Step-up framework (BACKEND-DESIGN §8, SF11/N8) and the {@link Ports.StepUpPort} implementation.
 *
 * <p><b>Trust-on-first-use is anchored on {@code has_ever_had_device}, not on "currently zero active
 * devices".</b> TOFU is granted exactly once, for the genuinely first device an account ever binds:
 * {@link #assertStepUp} claims that exemption with an atomic {@code false -> true} flip on the user
 * row, so it can never be granted twice - closing the "deauthorise-all-then-TOFU-a-rogue-device"
 * trust-root takeover. Once the flag is true, re-establishing a device from empty ALWAYS needs a
 * valid out-of-band proof.
 *
 * <p>Out-of-band factors: an emailed one-time code (if email-verified), OAuth re-auth, or the
 * one-time recovery code shown at registration (device-only accounts). The presented
 * {@code X-Step-Up-Token} is matched by hash against a single-use, unexpired {@link StepUpChallenge}
 * for the exact {@code (user, action)}; the persistent recovery code is a hash fallback on the user.
 */
@Service
public class StepUpService implements Ports.StepUpPort {

  private final StepUpChallengeRepository challenges;
  private final UserRepository users;
  private final OAuthIdentityRepository identities;
  private final OAuthTokenVerifier verifier;
  private final MongoTemplate mongo;
  private final AppProperties props;
  private final AuthEmailSender email;

  public StepUpService(
      StepUpChallengeRepository challenges,
      UserRepository users,
      OAuthIdentityRepository identities,
      OAuthTokenVerifier verifier,
      MongoTemplate mongo,
      AppProperties props,
      AuthEmailSender email) {
    this.challenges = challenges;
    this.users = users;
    this.identities = identities;
    this.verifier = verifier;
    this.mongo = mongo;
    this.props = props;
    this.email = email;
  }

  /** What {@code /auth/step-up/begin} learned about how to satisfy the challenge. */
  public record BeginResult(String challengeId, String factor, Instant expiresAt) {}

  /** A one-time step-up secret to present as {@code X-Step-Up-Token}. */
  public record StepUpToken(String stepUpToken, Instant expiresAt) {}

  // ---- Ports.StepUpPort -------------------------------------------------------------------------

  @Override
  public void assertStepUp(String userId, String proof, String action) {
    // TOFU applies ONLY to the first device an account ever binds. Claim it atomically so it is
    // single-shot and race-safe: the update matches only while has_ever_had_device is still false.
    if (StepUpActions.DEVICE_REGISTER.equals(action)) {
      User claimed =
          mongo.findAndModify(
              query(where("_id").is(userId).and("has_ever_had_device").is(false)),
              new Update().set("has_ever_had_device", true).set("updated_at", Instant.now()),
              User.class);
      if (claimed != null) {
        return; // genuine first device: trusted on first use
      }
      // Not the first device ever -> fall through and demand a real proof.
    }

    if (verifyProof(userId, proof, action)) {
      return;
    }
    throw ApiException.stepUpRequired("step-up required for " + action);
  }

  // ---- begin challenges -------------------------------------------------------------------------

  /** Starts an emailed-code step-up (the async factor); tells the client which factor to use. */
  public BeginResult begin(String userId, String action) {
    User user = requireUser(userId);

    if (user.getEmail() != null && user.isEmailVerified()) {
      Instant now = Instant.now();
      String code = Tokens.code();
      StepUpChallenge challenge =
          new StepUpChallenge(
              Uuid7.generate(),
              userId,
              action,
              Tokens.sha256(code),
              now.plusSeconds(props.getAuth().getStepUpTokenTtlSeconds()),
              now);
      challenges.save(challenge);
      email.sendStepUpCode(user.getEmail(), code);
      return new BeginResult(challenge.getId(), "email_code", challenge.getExpiresAt());
    }
    if (user.getRecoveryCodeHash() != null) {
      // Device-only: the user already holds their recovery code and presents it directly.
      return new BeginResult(null, "recovery_code", null);
    }
    if (identities.existsByUserId(userId)) {
      return new BeginResult(null, "oauth_reauth", null);
    }
    throw new ApiException(ErrorCode.VALIDATION_ERROR, "no step-up factor available for this account");
  }

  /** OAuth re-auth factor: verify a fresh id_token for this user, mint a one-time step-up secret. */
  public StepUpToken beginViaOAuth(
      String userId, String provider, String idToken, String nonce, String action) {
    VerifiedIdentity id = verifier.verify(provider, idToken, nonce);
    boolean bound =
        identities
            .findByProviderAndProviderSub(provider, id.sub())
            .map(oi -> oi.getUserId().equals(userId))
            .orElse(false);
    if (!bound) {
      throw ApiException.stepUpRequired("oauth re-auth did not match this account");
    }
    Instant now = Instant.now();
    String secret = Tokens.opaque();
    challenges.save(
        new StepUpChallenge(
            Uuid7.generate(),
            userId,
            action,
            Tokens.sha256(secret),
            now.plusSeconds(props.getAuth().getStepUpTokenTtlSeconds()),
            now));
    return new StepUpToken(secret, now.plusSeconds(props.getAuth().getStepUpTokenTtlSeconds()));
  }

  // ---- proof verification -----------------------------------------------------------------------

  private boolean verifyProof(String userId, String proof, String action) {
    if (proof == null || proof.isBlank()) {
      return false;
    }
    String hash = Tokens.sha256(proof);

    // 1) Single-use challenge: consume it atomically so a proof can never be replayed.
    Instant now = Instant.now();
    StepUpChallenge consumed =
        mongo.findAndModify(
            query(
                where("user_id")
                    .is(userId)
                    .and("action")
                    .is(action)
                    .and("challenge_hash")
                    .is(hash)
                    .and("consumed_at")
                    .is(null)
                    .and("expires_at")
                    .gt(now)),
            new Update().set("consumed_at", now),
            StepUpChallenge.class);
    if (consumed != null) {
      return true;
    }

    // 2) Persistent recovery code (device-only accounts): a hash fallback on the user row.
    User user = users.findById(userId).orElse(null);
    return user != null
        && user.getRecoveryCodeHash() != null
        && Tokens.constantTimeEquals(hash, user.getRecoveryCodeHash());
  }

  private User requireUser(String userId) {
    return users
        .findById(userId)
        .filter(u -> User.STATUS_ACTIVE.equals(u.getStatus()))
        .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "account not found"));
  }
}
