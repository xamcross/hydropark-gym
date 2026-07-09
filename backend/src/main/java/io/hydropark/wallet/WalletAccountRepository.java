package io.hydropark.wallet;

import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

/**
 * Point lookups. The self-guarding debit and the credit/clawback balance mutations use {@link
 * WalletService}'s {@code MongoTemplate} directly, because they need conditional {@code
 * findAndModify}, not derived finders.
 */
public interface WalletAccountRepository extends MongoRepository<WalletAccount, String> {

  Optional<WalletAccount> findByUserId(String userId);
}
