package io.hydropark.wallet;

import io.hydropark.common.ApiException;
import io.hydropark.common.CursorPage;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.common.Uuid7;
import io.hydropark.port.Ports;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

/**
 * BACKLOG P1-18 (BE §3.5, §5.4, §5.5). Implements {@link Ports.WalletPort} plus the read side of the
 * wallet endpoints.
 *
 * <p>The money mutations here are called from inside the settlement worker's {@code @Transactional}
 * call (see the {@link Ports.WalletPort} contract), so they join the ambient Mongo session - this
 * class never opens its own. Within that transaction, an idempotent ledger insert and the atomic
 * balance mutation commit together or not at all.
 *
 * <p>Four invariants are non-negotiable (AGENT-CONTRACT §8/§9, BE §3.5):
 *
 * <ol>
 *   <li><b>The debit is one self-guarding statement.</b> A single {@code findAndModify} matching
 *       {@code status='active' AND balance >= price} with {@code $inc:{balance:-price}}. Null means
 *       insufficient <em>or</em> frozen. There is no read-then-write on the money path.
 *   <li><b>Balance may go negative and is never clamped.</b> Only the debit carries {@code
 *       balance >= price}; the clawback deliberately has no lower bound.
 *   <li><b>Only settled credit is spendable.</b> {@code balance} advances only on a settled top-up.
 *   <li><b>Cross-currency is rejected</b> with {@code WALLET_CURRENCY_MISMATCH}.
 * </ol>
 */
@Service
public class WalletService implements Ports.WalletPort {

  private static final Logger log = LoggerFactory.getLogger(WalletService.class);

  private final MongoTemplate mongo;
  private final WalletAccountRepository accounts;
  private final Ports.GrantPort grants;

  public WalletService(
      MongoTemplate mongo, WalletAccountRepository accounts, Ports.GrantPort grants) {
    this.mongo = mongo;
    this.accounts = accounts;
    this.grants = grants;
  }

  // ---------------------------------------------------------------------------------------------
  // WalletPort.currencyOf  (read by commerce to validate a top-up currency BEFORE checkout, §3.5)
  // ---------------------------------------------------------------------------------------------

  /**
   * The currency this wallet is fixed to, or empty if it has never been topped up. The wallet row is
   * created only by a top-up ({@link #ensureWallet} runs from {@link #creditSettledTopup} /
   * {@link #recordPendingTopup}), so "no wallet row" is exactly "never topped up" - a fresh user
   * yields {@link java.util.Optional#empty()}, and the first settled top-up fixes the currency
   * returned here. {@code commerce} calls this to reject a mismatched top-up at checkout, while no
   * money has moved (see {@link Ports.WalletPort#currencyOf}).
   */
  @Override
  public java.util.Optional<String> currencyOf(String userId) {
    return accounts.findByUserId(userId).map(WalletAccount::getCurrency);
  }

  // ---------------------------------------------------------------------------------------------
  // WalletPort.debitForOrder  (called inside the settlement worker transaction, §5.4)
  // ---------------------------------------------------------------------------------------------

  /**
   * Self-guarding conditional debit. Throws INSUFFICIENT_BALANCE / WALLET_FROZEN /
   * WALLET_CURRENCY_MISMATCH rather than returning a boolean.
   */
  @Override
  public void debitForOrder(String userId, String orderId, Money price, String idempotencyKey) {
    WalletAccount wallet = accounts.findByUserId(userId).orElse(null);
    if (wallet == null) {
      // No wallet means no settled credit at all.
      throw new ApiException(ErrorCode.INSUFFICIENT_BALANCE, "no wallet to debit");
    }
    // Cross-currency guard (business rule, not the overdraft guard). §3.5.
    if (!wallet.getCurrency().equalsIgnoreCase(price.currency())) {
      throw currencyMismatch(wallet.getCurrency(), price.currency());
    }

    // Insert-first idempotency guard: a replay of the same key duplicate-keys and short-circuits
    // before the $inc runs (which is not idempotent). Inside the worker txn a later failure rolls
    // this row back too, so a rejected debit never leaves an orphan ledger line.
    appendLedger(wallet.getId(), -price.amount(), WalletTransaction.PURCHASE, orderId, true, idempotencyKey);

    // The single self-guarding statement. status='active' AND balance>=price, both atomic with the
    // decrement: two parallel spends can never both pass a stale read.
    Query guard =
        Query.query(
            Criteria.where("id")
                .is(wallet.getId())
                .and("status")
                .is(WalletAccount.ACTIVE)
                .and("balance")
                .gte(price.amount()));
    Update debit = new Update().inc("balance", -price.amount()).set("updatedAt", Instant.now());
    WalletAccount updated =
        mongo.findAndModify(
            guard, debit, FindAndModifyOptions.options().returnNew(true), WalletAccount.class);

    if (updated == null) {
      // Distinguish frozen from insufficient purely to return the precise wire code. This read does
      // NOT gate the mutation - the atomic guard above already did - so it introduces no race.
      WalletAccount current = mongo.findById(wallet.getId(), WalletAccount.class);
      if (current != null && WalletAccount.FROZEN.equals(current.getStatus())) {
        throw new ApiException(ErrorCode.WALLET_FROZEN, "wallet is frozen");
      }
      throw new ApiException(ErrorCode.INSUFFICIENT_BALANCE, "insufficient wallet balance");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // WalletPort.creditSettledTopup  (top-up finality)
  // ---------------------------------------------------------------------------------------------

  /**
   * Credit a settled top-up and advance the spendable balance. Fixes the wallet currency on the
   * first top-up (§3.5).
   */
  @Override
  public void creditSettledTopup(String userId, String orderId, Money amount, String idempotencyKey) {
    WalletAccount wallet = ensureWallet(userId, amount.currency());
    if (!wallet.getCurrency().equalsIgnoreCase(amount.currency())) {
      // Currency is fixed at first top-up; a later top-up in a different currency has no defined FX.
      throw currencyMismatch(wallet.getCurrency(), amount.currency());
    }

    // Insert-first, settled=true. Duplicate key => this top-up already settled; short-circuit.
    appendLedger(wallet.getId(), amount.amount(), WalletTransaction.TOPUP, orderId, true, idempotencyKey);

    // Only settled credit advances balance (§5.5). No status guard: a settled payment is recorded
    // even on a frozen wallet (it can only reduce a negative deficit); spend remains blocked.
    mongo.findAndModify(
        Query.query(Criteria.where("id").is(wallet.getId())),
        new Update().inc("balance", amount.amount()).set("updatedAt", Instant.now()),
        FindAndModifyOptions.options().returnNew(true),
        WalletAccount.class);
  }

  // ---------------------------------------------------------------------------------------------
  // WalletPort.clawbackTopup  (§5.5.5 SF4)
  // ---------------------------------------------------------------------------------------------

  /**
   * A top-up chargeback: append a compensating negative row, freeze the wallet, then hand off to
   * licensing to revoke wallet-funded grants most-recent-first up to the clawed-back amount. The
   * balance may go negative here - it is recorded, never clamped.
   */
  @Override
  public void clawbackTopup(String userId, String orderId, Money amount, String idempotencyKey) {
    WalletAccount wallet =
        accounts.findByUserId(userId).orElseThrow(() -> ApiException.notFound("wallet"));

    // Insert-first: the compensating -amount clawback row. Duplicate key => already clawed back.
    appendLedger(wallet.getId(), -amount.amount(), WalletTransaction.CLAWBACK, orderId, true, idempotencyKey);

    // Decrement + freeze + flag in one atomic update. Crucially NO balance>=0 guard - the design
    // (§3.5) drops the CHECK precisely so this update cannot be aborted by a negative result.
    mongo.findAndModify(
        Query.query(Criteria.where("id").is(wallet.getId())),
        new Update()
            .inc("balance", -amount.amount())
            .set("status", WalletAccount.FROZEN)
            .set("flagged", true)
            .set("updatedAt", Instant.now()),
        FindAndModifyOptions.options().returnNew(true),
        WalletAccount.class);

    log.warn(
        "wallet clawback: user={} order={} amount={} {} - wallet frozen and flagged (SF4/SF10)",
        userId,
        orderId,
        amount.amount(),
        amount.currency());

    // The most-recent-first wallet-grant walk lives in licensing (Ports.GrantPort). Do NOT
    // reimplement it here. It joins the ambient worker transaction automatically.
    grants.revokeWalletGrantsMostRecentFirst(userId, amount.amount());
  }

  // ---------------------------------------------------------------------------------------------
  // Two-phase top-up: the pre-finality credit (webhook received, not yet settled)
  // ---------------------------------------------------------------------------------------------

  /**
   * Record an <b>unsettled</b> top-up credit (webhook received, pre-finality). It appends a {@code
   * settled=false} ledger row and <b>does not advance the balance</b>, so risky credit is unspendable
   * until {@link #creditSettledTopup} flips finality (§5.5). Package-private: the worker drives this,
   * not the public API.
   */
  void recordPendingTopup(String userId, String orderId, Money amount, String idempotencyKey) {
    WalletAccount wallet = ensureWallet(userId, amount.currency());
    if (!wallet.getCurrency().equalsIgnoreCase(amount.currency())) {
      throw currencyMismatch(wallet.getCurrency(), amount.currency());
    }
    appendLedger(wallet.getId(), amount.amount(), WalletTransaction.TOPUP, orderId, false, idempotencyKey);
    // Deliberately no balance mutation: unsettled credit is not spendable.
  }

  // ---------------------------------------------------------------------------------------------
  // Read side: GET /v1/wallet, GET /v1/wallet/transactions
  // ---------------------------------------------------------------------------------------------

  public WalletAccount findWallet(String userId) {
    return accounts.findByUserId(userId).orElse(null);
  }

  /** Cursor-paginated ledger, newest first. Empty when the user has no wallet yet. */
  public CursorPage<WalletTransaction> listTransactions(String userId, Integer limit, String cursor) {
    WalletAccount wallet = accounts.findByUserId(userId).orElse(null);
    if (wallet == null) {
      return new CursorPage<>(List.of(), null);
    }
    int lim = CursorPage.clampLimit(limit);
    String after = CursorPage.decode(cursor);

    Query q = Query.query(Criteria.where("walletId").is(wallet.getId()));
    if (after != null) {
      // Newest-first: the cursor is the last (smallest) id seen; page the next-older rows.
      q.addCriteria(Criteria.where("id").lt(after));
    }
    q.with(Sort.by(Sort.Direction.DESC, "id")).limit(lim + 1);
    List<WalletTransaction> rows = mongo.find(q, WalletTransaction.class);
    return CursorPage.from(rows, lim, WalletTransaction::getId);
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  /** Get-or-create the wallet, fixing currency on creation. Handles the concurrent-create race. */
  private WalletAccount ensureWallet(String userId, String currency) {
    WalletAccount existing = accounts.findByUserId(userId).orElse(null);
    if (existing != null) {
      return existing;
    }
    WalletAccount fresh =
        new WalletAccount(
            Uuid7.generate(), userId, 0L, WalletAccount.ACTIVE, currency, Instant.now());
    try {
      return accounts.insert(fresh);
    } catch (DuplicateKeyException race) {
      // The unique (user_id) index rejected a concurrent create; use the winner.
      return accounts.findByUserId(userId).orElseThrow(() -> ApiException.notFound("wallet"));
    }
  }

  /**
   * Append one ledger row. The unique {@code idempotency_key} index makes a replay duplicate-key
   * and short-circuit - we let {@link DuplicateKeyException} propagate as the intended replay guard
   * (rendered as CONFLICT by the global handler), matching the insert-first webhook-dedupe pattern.
   */
  private void appendLedger(
      String walletId, long delta, String reason, String orderId, boolean settled, String idempotencyKey) {
    WalletTransaction tx =
        new WalletTransaction(
            Uuid7.generate(), walletId, delta, reason, orderId, settled, idempotencyKey, Instant.now());
    mongo.insert(tx);
  }

  private static ApiException currencyMismatch(String walletCurrency, String requested) {
    return new ApiException(
        ErrorCode.WALLET_CURRENCY_MISMATCH,
        "wallet holds " + walletCurrency + " but " + requested + " was requested",
        java.util.Map.of("wallet_currency", walletCurrency, "requested_currency", requested));
  }
}
