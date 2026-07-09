package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.auth.domain.RefreshToken;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.RefreshTokenRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.RefreshTokenService;
import io.hydropark.auth.support.Tokens;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import io.hydropark.security.AccessTokenService;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.UpdateDefinition;

/**
 * §8/§3.6 refresh-token reuse detection and the retry-grace exception. Pure unit tests over mocked
 * persistence - the rotation logic, not Mongo, is under test.
 */
class RefreshTokenServiceTest {

  private RefreshTokenRepository refreshTokens;
  private UserRepository users;
  private MongoTemplate mongo;
  private AccessTokenService accessTokens;
  private RefreshTokenService service;

  private final User activeUser = new User("u1", null, null, null, Instant.now());

  @BeforeEach
  void setUp() {
    refreshTokens = mock(RefreshTokenRepository.class);
    users = mock(UserRepository.class);
    mongo = mock(MongoTemplate.class);
    accessTokens = mock(AccessTokenService.class);
    AppProperties props = new AppProperties(); // real defaults: grace = 60s
    service = new RefreshTokenService(refreshTokens, users, mongo, accessTokens, props);

    when(users.findById("u1")).thenReturn(Optional.of(activeUser));
    when(accessTokens.issue(eq("u1"), anyBoolean())).thenReturn("access-jwt");
  }

  @Test
  void reuseOfAnAlreadyUsedTokenRevokesTheWholeFamily() {
    String presented = "stolen-token";
    RefreshToken row = usedRow(presented, "fam-1", "row-1", Instant.now().minusSeconds(600));
    when(refreshTokens.findByTokenHash(Tokens.sha256(presented))).thenReturn(Optional.of(row));
    // Even with a live child, presentation BEYOND the grace window is treated as theft.
    when(refreshTokens.existsByPrevIdAndRevokedFalse("row-1")).thenReturn(true);

    assertThatThrownBy(() -> service.rotate(presented))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.UNAUTHORIZED));

    // The whole family was revoked.
    verify(mongo).updateMulti(any(Query.class), any(UpdateDefinition.class), eq(RefreshToken.class));
  }

  @Test
  void representingTheImmediatelyPriorTokenWithinGraceDoesNotRevoke() {
    String presented = "prior-token";
    RefreshToken prior = usedRow(presented, "fam-2", "row-2", Instant.now());
    RefreshToken tip = new RefreshToken("tip-2", "u1", "fam-2", "tip-hash", "row-2", future(), Instant.now());

    when(refreshTokens.findByTokenHash(Tokens.sha256(presented))).thenReturn(Optional.of(prior));
    when(refreshTokens.existsByPrevIdAndRevokedFalse("row-2")).thenReturn(true);
    when(refreshTokens.findByFamilyIdAndUsedAtIsNullAndRevokedFalseOrderByIdDesc("fam-2"))
        .thenReturn(List.of(tip));
    // Atomic claim of the tip succeeds (grace rotation proceeds from the current tip).
    when(mongo.findAndModify(
            any(Query.class),
            any(UpdateDefinition.class),
            any(FindAndModifyOptions.class),
            eq(RefreshToken.class)))
        .thenReturn(tip);

    var tokens = service.rotate(presented);

    assertThat(tokens.accessJwt()).isEqualTo("access-jwt");
    assertThat(tokens.refreshToken()).isNotBlank();
    // Crucially, NO family revocation happened.
    verify(mongo, never())
        .updateMulti(any(Query.class), any(UpdateDefinition.class), eq(RefreshToken.class));
  }

  private RefreshToken usedRow(String plaintext, String familyId, String id, Instant usedAt) {
    RefreshToken row =
        new RefreshToken(id, "u1", familyId, Tokens.sha256(plaintext), null, future(), Instant.now());
    row.setUsedAt(usedAt);
    return row;
  }

  private static Instant future() {
    return Instant.now().plusSeconds(3600);
  }
}
