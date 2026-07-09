package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the wallet collections (BACKEND-DESIGN §3.5): {@code wallet_accounts}, {@code
 * wallet_transactions}.
 *
 * <p>{@code wallet_transactions.idempotency_key} unique is what makes the append-only ledger safe
 * to retry (Appendix A) - the self-guarding debit in the settlement worker is itself atomic, but
 * a retried request must not append a second ledger row for the same logical operation.
 */
@Component
public class V007CreateWalletIndexes implements Migration {

  @Override
  public String id() {
    return "V007__create_wallet_indexes";
  }

  @Override
  public String description() {
    return "unique wallet_accounts.user_id; unique wallet_transactions.idempotency_key + query indexes";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // wallet_accounts: one wallet per user (Postgres UNIQUE REFERENCES users(id)).
    mongo.getCollection("wallet_accounts")
        .createIndex(Indexes.ascending("user_id"), new IndexOptions().name("wallet_accounts_user_id_unique").unique(true));

    // wallet_transactions: idempotency_key uniqueness guards double-apply of a topup/spend/refund
    // (§3.5, Appendix A) independent of the settlement worker's own atomicity.
    mongo.getCollection("wallet_transactions")
        .createIndex(
            Indexes.ascending("idempotency_key"),
            new IndexOptions().name("wallet_transactions_idempotency_key_unique").unique(true));

    // Ledger listing for a wallet, newest first (GET /wallet/transactions, cursor-paginated §4.7).
    mongo.getCollection("wallet_transactions")
        .createIndex(
            Indexes.descending("wallet_id", "created_at"),
            new IndexOptions().name("wallet_transactions_wallet_id_created_idx"));

    // Reverse lookup: "which wallet transaction resulted from this order" (topup settlement,
    // refund/clawback correlation).
    mongo.getCollection("wallet_transactions")
        .createIndex(Indexes.ascending("order_id"), new IndexOptions().name("wallet_transactions_order_id_idx"));
  }
}
