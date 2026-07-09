package io.hydropark.auth.service;

import static org.springframework.data.mongodb.core.query.Criteria.where;
import static org.springframework.data.mongodb.core.query.Query.query;

import io.hydropark.auth.domain.RefreshToken;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.RefreshTokenRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.support.Tokens;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import io.hydropark.security.AccessTokenService;
import java.time.Instant;
import java.util.List;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Rotating refresh tokens with reuse detection (BACKEND-DESIGN §3.6, §8, SF11 N11).
 *
 * <ul>
 *   <li>Every login opens a {@code family_id}. Each refresh marks the presented row {@code used_at}
 *       and mints a child ({@code prev_id} back-pointer).
 *   <li>Presenting a token whose row already has {@code used_at} normally means theft: the whole
 *       family is revoked and re-login is forced.
 *   <li><b>Retry grace:</b> if the presented (already-used) token was rotated within
 *       {@code refresh-retry-grace-seconds} and still has a live child, it is treated as a dropped
 *       response on a flaky network - we rotate from the current family tip and return a working pair
 *       instead of revoking. The {@code prev_id} chain (a live child within the window) is what
 *       distinguishes this from genuine out-of-chain reuse.
 * </ul>
 */
@Service
public class RefreshTokenService {

  private final RefreshTokenRepository refreshTokens;
  private final UserRepository users;
  private final MongoTemplate mongo;
  private final AccessTokenService accessTokens;
  private final AppProperties props;

  public RefreshTokenService(
      RefreshTokenRepository refreshTokens,
      UserRepository users,
      MongoTemplate mongo,
      AccessTokenService accessTokens,
      AppProperties props) {
    this.refreshTokens = refreshTokens;
    this.users = users;
    this.mongo = mongo;
    this.accessTokens = accessTokens;
    this.props = props;
  }

  /** Login/register: open a brand-new family and return the first token pair. */
  public AuthTokens issueNewFamily(User user) {
    return mint(user, Uuid7.generate(), null);
  }

  /** Presents a refresh token, applying rotation / grace / reuse-detection. */
  @Transactional
  public AuthTokens rotate(String presented) {
    Instant now = Instant.now();
    String hash = Tokens.sha256(presented);

    RefreshToken row = refreshTokens.findByTokenHash(hash).orElse(null);
    if (row == null) {
      throw unauthorized("invalid refresh token");
    }
    if (row.isRevoked()) {
      throw unauthorized("refresh token revoked; re-login required");
    }
    if (row.getExpiresAt().isBefore(now)) {
      throw unauthorized("refresh token expired");
    }

    User user = requireActiveUser(row.getUserId());

    if (row.getUsedAt() == null) {
      // Normal path: atomically claim the row so two concurrent submits can't both rotate it.
      RefreshToken claimed = claim(row.getId(), now);
      if (claimed != null) {
        return mint(user, row.getFamilyId(), row.getId());
      }
      // Lost the race - someone just used it. Re-read and fall into the used-token handling.
      row = refreshTokens.findByTokenHash(hash).orElse(row);
    }

    // Used-token path: grace vs. reuse.
    long graceSeconds = props.getAuth().getRefreshRetryGraceSeconds();
    boolean withinGrace =
        row.getUsedAt() != null && !row.getUsedAt().isBefore(now.minusSeconds(graceSeconds));
    boolean hasLiveChild = refreshTokens.existsByPrevIdAndRevokedFalse(row.getId());

    if (withinGrace && hasLiveChild) {
      // Dropped-response retry, not theft: rotate from the current tip and return a fresh pair.
      RefreshToken tip = firstTip(row.getFamilyId());
      if (tip != null) {
        RefreshToken claimedTip = claim(tip.getId(), now);
        if (claimedTip != null) {
          return mint(user, tip.getFamilyId(), tip.getId());
        }
      }
      // No claimable tip (concurrent rotation): branch a child off the presented row, still no revoke.
      return mint(user, row.getFamilyId(), row.getId());
    }

    // Genuine reuse (out-of-chain or beyond grace): assume theft, revoke the whole family.
    revokeFamily(row.getFamilyId());
    throw unauthorized("refresh token reuse detected; family revoked");
  }

  /** Logout (§4.1): revoke the presented token's whole family. Idempotent for an unknown token. */
  public void revokeFamilyOf(String presented) {
    refreshTokens
        .findByTokenHash(Tokens.sha256(presented))
        .ifPresent(row -> revokeFamily(row.getFamilyId()));
  }

  /** Password reset (§4.1): invalidate every outstanding session for the user. */
  public void revokeAllForUser(String userId) {
    mongo.updateMulti(
        query(where("user_id").is(userId)),
        new Update().set("revoked", true).set("updated_at", Instant.now()),
        RefreshToken.class);
  }

  private AuthTokens mint(User user, String familyId, String prevId) {
    Instant now = Instant.now();
    String raw = Tokens.opaque();
    RefreshToken child =
        new RefreshToken(
            Uuid7.generate(),
            user.getId(),
            familyId,
            Tokens.sha256(raw),
            prevId,
            now.plusSeconds(props.getAuth().getRefreshTokenTtlSeconds()),
            now);
    refreshTokens.save(child);
    String access = accessTokens.issue(user.getId(), user.isEmailVerified());
    return new AuthTokens(access, raw);
  }

  /** Atomic single-use claim: sets {@code used_at} iff still null. Null result ⇒ already used. */
  private RefreshToken claim(String id, Instant now) {
    return mongo.findAndModify(
        query(where("_id").is(id).and("used_at").is(null)),
        new Update().set("used_at", now).set("updated_at", now),
        FindAndModifyOptions.options().returnNew(true),
        RefreshToken.class);
  }

  private RefreshToken firstTip(String familyId) {
    List<RefreshToken> tips =
        refreshTokens.findByFamilyIdAndUsedAtIsNullAndRevokedFalseOrderByIdDesc(familyId);
    return tips.isEmpty() ? null : tips.get(0);
  }

  private void revokeFamily(String familyId) {
    mongo.updateMulti(
        query(where("family_id").is(familyId)),
        new Update().set("revoked", true).set("updated_at", Instant.now()),
        RefreshToken.class);
  }

  private User requireActiveUser(String userId) {
    User u = users.findById(userId).orElseThrow(() -> unauthorized("account not found"));
    if (!User.STATUS_ACTIVE.equals(u.getStatus())) {
      throw unauthorized("account not active");
    }
    return u;
  }

  private static ApiException unauthorized(String message) {
    return new ApiException(ErrorCode.UNAUTHORIZED, message);
  }
}
