package io.hydropark.auth.service;

import io.hydropark.auth.domain.OAuthIdentity;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.OAuthIdentityRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.AuthService.Issued;
import io.hydropark.auth.service.OAuthTokenVerifier.VerifiedIdentity;
import io.hydropark.auth.support.Emails;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Uuid7;
import java.time.Instant;
import java.util.Set;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * OAuth login/registration (SF6). The provider {@code id_token} is verified
 * ({@link OAuthTokenVerifier}), then find-or-create keys on {@code (provider, provider_sub)} only.
 *
 * <p><b>Never auto-merge by unverified email.</b> A first-time OAuth login always creates a new user
 * bound to the provider subject; it does not attach to a pre-existing local account that happens to
 * share the email. The token email is copied onto the <em>new</em> user only when the provider marks
 * it verified <em>and</em> no other account already holds it - so a matching local account is never
 * silently taken over.
 */
@Service
public class OAuthService {

  private static final Set<String> SUPPORTED =
      Set.of(OAuthIdentity.PROVIDER_GOOGLE, OAuthIdentity.PROVIDER_APPLE);

  private final OAuthTokenVerifier verifier;
  private final OAuthIdentityRepository identities;
  private final UserRepository users;
  private final RefreshTokenService refreshTokens;

  public OAuthService(
      OAuthTokenVerifier verifier,
      OAuthIdentityRepository identities,
      UserRepository users,
      RefreshTokenService refreshTokens) {
    this.verifier = verifier;
    this.identities = identities;
    this.users = users;
    this.refreshTokens = refreshTokens;
  }

  public Issued loginOrRegister(String provider, String idToken, String nonce) {
    if (!SUPPORTED.contains(provider)) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, "unsupported oauth provider: " + provider);
    }
    VerifiedIdentity id = verifier.verify(provider, idToken, nonce);

    OAuthIdentity identity =
        identities.findByProviderAndProviderSub(provider, id.sub()).orElse(null);
    User user;
    if (identity != null) {
      user =
          users
              .findById(identity.getUserId())
              .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "oauth account missing"));
    } else {
      user = createOAuthUser(provider, id);
    }
    return new Issued(refreshTokens.issueNewFamily(user), user, null);
  }

  private User createOAuthUser(String provider, VerifiedIdentity id) {
    Instant now = Instant.now();
    String normalizedEmail = Emails.normalize(id.email());

    // Only adopt the email onto the NEW account when verified and unclaimed - never merge.
    boolean adoptEmail =
        normalizedEmail != null && id.emailVerified() && !users.existsByEmail(normalizedEmail);

    User user = new User(Uuid7.generate(), adoptEmail ? normalizedEmail : null, null, null, now);
    if (adoptEmail) {
      user.setEmailVerified(true);
    }
    users.save(user);

    try {
      identities.save(new OAuthIdentity(Uuid7.generate(), user.getId(), provider, id.sub(), now));
    } catch (DuplicateKeyException e) {
      // Concurrent first-login for the same subject: adopt the winner's identity + user.
      OAuthIdentity winner =
          identities
              .findByProviderAndProviderSub(provider, id.sub())
              .orElseThrow(() -> new ApiException(ErrorCode.CONFLICT, "oauth identity conflict"));
      return users
          .findById(winner.getUserId())
          .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "oauth account missing"));
    }
    return user;
  }
}
