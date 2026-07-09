package io.hydropark.auth.service;

import static org.springframework.data.mongodb.core.query.Criteria.where;
import static org.springframework.data.mongodb.core.query.Query.query;

import io.hydropark.auth.domain.EmailVerificationToken;
import io.hydropark.auth.domain.OAuthIdentity;
import io.hydropark.auth.domain.PasswordResetToken;
import io.hydropark.auth.domain.RefreshToken;
import io.hydropark.auth.domain.StepUpChallenge;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.event.AccountDeletionRequested;
import io.hydropark.auth.repo.OAuthIdentityRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.common.ApiException;
import io.hydropark.common.Uuid7;
import java.time.Instant;
import java.util.List;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * GDPR deletion + export (§8, P1-12.6).
 *
 * <p><b>Delete</b> is an anonymise-in-place job: the {@code users} row is kept (financial/tax records
 * elsewhere FK it) but its PII is scrubbed and status set to {@code deleted}. Because the row is not
 * hard-deleted, nothing cascades automatically, so the job explicitly drops the auth-owned children
 * ({@code oauth_identities}, {@code refresh_tokens}, {@code email_verification_tokens},
 * {@code password_reset_tokens}, {@code step_up_challenges}) and publishes
 * {@link AccountDeletionRequested} so other packages ({@code devices}, {@code wallet}, ...) cascade
 * the data this package must not touch. Job status is tracked on the user row (no separate
 * collection).
 *
 * <p><b>Export</b> returns only what auth owns; there is deliberately no conversation content
 * server-side (§1 principle 2) - a test asserts that invariant.
 */
@Service
public class AccountService {

  public static final String JOB_PENDING = "pending";
  public static final String JOB_COMPLETED = "completed";

  private final UserRepository users;
  private final OAuthIdentityRepository identities;
  private final MongoTemplate mongo;
  private final ApplicationEventPublisher events;

  public AccountService(
      UserRepository users,
      OAuthIdentityRepository identities,
      MongoTemplate mongo,
      ApplicationEventPublisher events) {
    this.users = users;
    this.identities = identities;
    this.mongo = mongo;
    this.events = events;
  }

  public record DeletionJob(
      @com.fasterxml.jackson.annotation.JsonProperty("job_id") String jobId,
      String status,
      @com.fasterxml.jackson.annotation.JsonProperty("requested_at") Instant requestedAt,
      @com.fasterxml.jackson.annotation.JsonProperty("completed_at") Instant completedAt) {}

  public record AccountExport(
      AccountView account,
      @com.fasterxml.jackson.annotation.JsonProperty("oauth_identities") List<OAuthView>
              oauthIdentities,
      String note) {}

  public record AccountView(
      String id,
      String email,
      @com.fasterxml.jackson.annotation.JsonProperty("email_verified") boolean emailVerified,
      String status,
      @com.fasterxml.jackson.annotation.JsonProperty("created_at") Instant createdAt) {}

  public record OAuthView(
      String provider,
      @com.fasterxml.jackson.annotation.JsonProperty("linked_at") Instant linkedAt) {}

  // ---- delete -----------------------------------------------------------------------------------

  @Transactional
  public DeletionJob startDeletion(String userId) {
    User user = users.findById(userId).orElseThrow(() -> ApiException.notFound("account"));

    // Idempotent: a repeat request returns the existing (completed) job.
    if (User.STATUS_DELETED.equals(user.getStatus()) && user.getDeletionJobId() != null) {
      return new DeletionJob(
          user.getDeletionJobId(),
          user.getDeletionStatus(),
          user.getDeletionRequestedAt(),
          user.getDeletionCompletedAt());
    }

    Instant now = Instant.now();
    String jobId = Uuid7.prefixed("del");
    user.setStatus(User.STATUS_DELETION_PENDING);
    user.setDeletionRequestedAt(now);
    user.setDeletionJobId(jobId);
    user.setDeletionStatus(JOB_PENDING);
    user.setUpdatedAt(now);
    users.save(user);

    // Other packages own user-referenced data we must not delete (devices, wallet, grants, orders,
    // download watermark buyer-tokens). They listen for this and cascade their own cleanup.
    events.publishEvent(new AccountDeletionRequested(userId));

    // Cascade the auth-owned children, then anonymise the user row in place.
    mongo.remove(byUser(userId), OAuthIdentity.class);
    mongo.remove(byUser(userId), RefreshToken.class);
    mongo.remove(byUser(userId), EmailVerificationToken.class);
    mongo.remove(byUser(userId), PasswordResetToken.class);
    mongo.remove(byUser(userId), StepUpChallenge.class);

    Instant done = Instant.now();
    user.setEmail(null);
    user.setEmailVerified(false);
    user.setPasswordHash(null);
    user.setRecoveryCodeHash(null);
    user.setStatus(User.STATUS_DELETED);
    user.setDeletionStatus(JOB_COMPLETED);
    user.setDeletionCompletedAt(done);
    user.setUpdatedAt(done);
    users.save(user);

    return new DeletionJob(jobId, JOB_COMPLETED, now, done);
  }

  public DeletionJob jobStatus(String userId, String jobId) {
    User user = users.findByDeletionJobId(jobId).orElse(null);
    // Scope to the caller's own job; do not reveal another user's job even by id.
    if (user == null || !user.getId().equals(userId)) {
      throw ApiException.notFound("deletion job");
    }
    return new DeletionJob(
        user.getDeletionJobId(),
        user.getDeletionStatus(),
        user.getDeletionRequestedAt(),
        user.getDeletionCompletedAt());
  }

  // ---- export -----------------------------------------------------------------------------------

  public AccountExport export(String userId) {
    User user = users.findById(userId).orElseThrow(() -> ApiException.notFound("account"));
    List<OAuthView> oauth =
        identities.findByUserId(userId).stream()
            .map(oi -> new OAuthView(oi.getProvider(), oi.getCreatedAt()))
            .toList();
    AccountView account =
        new AccountView(
            user.getId(),
            user.getEmail(),
            user.isEmailVerified(),
            user.getStatus(),
            user.getCreatedAt());
    return new AccountExport(
        account,
        oauth,
        "No conversation content exists server-side; conversations live only on-device (SPEC §14).");
  }

  private static org.springframework.data.mongodb.core.query.Query byUser(String userId) {
    return query(where("user_id").is(userId));
  }
}
