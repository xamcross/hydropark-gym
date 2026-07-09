package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.OAuthIdentityRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.AccountService;
import io.hydropark.auth.service.AccountService.AccountExport;
import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.mongodb.core.MongoTemplate;

/**
 * §1 principle 2 / §8: <b>no conversation content exists server-side</b>. There is no conversations
 * collection anywhere in the backend; conversations live only on-device (SPEC §14). This test
 * documents that invariant by asserting the GDPR export exposes only account + oauth data and carries
 * no field that could hold conversation content.
 */
class AccountExportInvariantTest {

  @Test
  void exportContainsAccountAndOauthOnlyAndNeverConversationContent() {
    UserRepository users = mock(UserRepository.class);
    OAuthIdentityRepository identities = mock(OAuthIdentityRepository.class);
    MongoTemplate mongo = mock(MongoTemplate.class);
    ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    AccountService service = new AccountService(users, identities, mongo, events);

    User user = new User("u1", "person@example.com", "hash", null, Instant.now());
    when(users.findById("u1")).thenReturn(Optional.of(user));
    when(identities.findByUserId("u1")).thenReturn(List.of());

    AccountExport export = service.export("u1");

    assertThat(export.account()).isNotNull();
    assertThat(export.oauthIdentities()).isEmpty();
    assertThat(export.note()).contains("No conversation content");

    // No component of the export (or its nested records) is named or typed to carry conversations.
    assertNoConversationField(AccountExport.class);
    assertNoConversationField(AccountService.AccountView.class);
    assertNoConversationField(AccountService.OAuthView.class);
  }

  private static void assertNoConversationField(Class<?> record) {
    for (RecordComponent c : record.getRecordComponents()) {
      assertThat(c.getName().toLowerCase()).doesNotContain("conversation");
      assertThat(c.getName().toLowerCase()).doesNotContain("message");
      assertThat(c.getName().toLowerCase()).doesNotContain("chat");
    }
  }
}
