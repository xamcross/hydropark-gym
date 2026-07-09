package io.hydropark.wallet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.port.Ports;
import java.util.Optional;
import org.bson.Document;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;

/**
 * Unit tests for the wallet money invariants (BE §3.5, AGENT-CONTRACT §8/§9). These use a mocked
 * {@link MongoTemplate}: the point is to pin the <em>query shape</em> and the control flow, not to
 * exercise a live Mongo. NOT RUN by this agent, per the contract.
 */
class WalletServiceTest {

  private final MongoTemplate mongo = mock(MongoTemplate.class);
  private final WalletAccountRepository accounts = mock(WalletAccountRepository.class);
  private final Ports.GrantPort grants = mock(Ports.GrantPort.class);
  private final WalletService service = new WalletService(mongo, accounts, grants);

  private static WalletAccount wallet(long balance, String status, String currency) {
    WalletAccount w = new WalletAccount("w1", "u1", balance, status, currency, java.time.Instant.now());
    w.setId("w1");
    return w;
  }

  /**
   * The debit MUST be one self-guarding statement: {@code status=active AND balance>=price} atomic
   * with the decrement. We assert that exact filter reaches {@code findAndModify} - it is what makes
   * a concurrent overdraw impossible.
   */
  @Test
  void debitIsAsingleSelfGuardingConditionalStatement() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(500, WalletAccount.ACTIVE, "USD")));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class)))
        .thenReturn(wallet(300, WalletAccount.ACTIVE, "USD"));

    service.debitForOrder("u1", "o1", new Money(200, "USD"), "idem-1");

    ArgumentCaptor<Query> q = ArgumentCaptor.forClass(Query.class);
    verify(mongo)
        .findAndModify(q.capture(), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class));
    Document filter = q.getValue().getQueryObject();
    assertThat(filter.get("status")).isEqualTo(WalletAccount.ACTIVE);
    assertThat(filter.get("balance")).isInstanceOf(Document.class);
    assertThat(((Document) filter.get("balance")).get("$gte")).isEqualTo(200L);
  }

  /**
   * Simulates the lost-update case: the atomic guard returns null (another spend won the race, or
   * funds are short). The service must throw from the atomic result alone - never re-read balance
   * and re-decide. A non-frozen wallet -> INSUFFICIENT_BALANCE.
   */
  @Test
  void debitNullResultThrowsInsufficientWithoutReadThenWrite() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(0, WalletAccount.ACTIVE, "USD")));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class)))
        .thenReturn(null);
    when(mongo.findById("w1", WalletAccount.class)).thenReturn(wallet(0, WalletAccount.ACTIVE, "USD"));

    assertThatThrownBy(() -> service.debitForOrder("u1", "o1", new Money(100, "USD"), "idem-2"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.INSUFFICIENT_BALANCE);
  }

  /** A null atomic result on a frozen wallet is reported as WALLET_FROZEN, not insufficient. */
  @Test
  void debitOnFrozenWalletThrowsWalletFrozen() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(1000, WalletAccount.FROZEN, "USD")));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class)))
        .thenReturn(null);
    when(mongo.findById("w1", WalletAccount.class)).thenReturn(wallet(1000, WalletAccount.FROZEN, "USD"));

    assertThatThrownBy(() -> service.debitForOrder("u1", "o1", new Money(100, "USD"), "idem-3"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.WALLET_FROZEN);
  }

  /**
   * A wallet funds only same-currency purchases. A cross-currency spend is rejected BEFORE any
   * ledger write or balance mutation.
   */
  @Test
  void crossCurrencySpendIsRejected() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(10_000, WalletAccount.ACTIVE, "USD")));

    assertThatThrownBy(() -> service.debitForOrder("u1", "o1", new Money(100, "EUR"), "idem-4"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.WALLET_CURRENCY_MISMATCH);

    verify(mongo, never())
        .findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class));
    verify(mongo, never()).insert(any(WalletTransaction.class));
  }

  /**
   * An UNSETTLED top-up must not be spendable: recording a pending credit appends a settled=false
   * ledger row and does NOT advance the balance (no balance {@code findAndModify} at all).
   */
  @Test
  void unsettledTopupDoesNotAdvanceBalance() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(0, WalletAccount.ACTIVE, "USD")));

    service.recordPendingTopup("u1", "o1", new Money(5_000, "USD"), "idem-pending");

    // The ledger row is written...
    ArgumentCaptor<WalletTransaction> tx = ArgumentCaptor.forClass(WalletTransaction.class);
    verify(mongo).insert(tx.capture());
    assertThat(tx.getValue().isSettled()).isFalse();
    // ...but the balance is never touched.
    verify(mongo, never())
        .findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class));
  }

  /** A settled top-up advances the balance by +amount. */
  @Test
  void settledTopupAdvancesBalance() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(0, WalletAccount.ACTIVE, "USD")));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class)))
        .thenReturn(wallet(5_000, WalletAccount.ACTIVE, "USD"));

    service.creditSettledTopup("u1", "o1", new Money(5_000, "USD"), "idem-settled");

    ArgumentCaptor<Update> u = ArgumentCaptor.forClass(Update.class);
    verify(mongo)
        .findAndModify(any(Query.class), u.capture(), any(FindAndModifyOptions.class), eq(WalletAccount.class));
    Document inc = (Document) u.getValue().getUpdateObject().get("$inc");
    assertThat(inc.get("balance")).isEqualTo(5_000L);
  }

  /**
   * A clawback must be allowed to drive the balance NEGATIVE without throwing, and it must not carry
   * a {@code balance>=0} guard (that would abort the very update the design requires - §3.5). It
   * freezes the wallet and hands the grant walk to licensing.
   */
  @Test
  void clawbackDrivesBalanceNegativeAndFreezesWithoutClamp() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.of(wallet(0, WalletAccount.ACTIVE, "USD")));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(WalletAccount.class)))
        .thenReturn(wallet(-5_000, WalletAccount.FROZEN, "USD"));

    assertThatCode(() -> service.clawbackTopup("u1", "o1", new Money(5_000, "USD"), "idem-claw"))
        .doesNotThrowAnyException();

    ArgumentCaptor<Query> q = ArgumentCaptor.forClass(Query.class);
    ArgumentCaptor<Update> u = ArgumentCaptor.forClass(Update.class);
    verify(mongo)
        .findAndModify(q.capture(), u.capture(), any(FindAndModifyOptions.class), eq(WalletAccount.class));

    // No lower-bound clamp on the clawback filter - the whole point of dropping CHECK(balance>=0).
    assertThat(q.getValue().getQueryObject().containsKey("balance")).isFalse();
    Document update = u.getValue().getUpdateObject();
    assertThat(((Document) update.get("$inc")).get("balance")).isEqualTo(-5_000L);
    assertThat(((Document) update.get("$set")).get("status")).isEqualTo(WalletAccount.FROZEN);

    // The most-recent-first grant revocation is delegated to licensing, never reimplemented here.
    verify(grants).revokeWalletGrantsMostRecentFirst("u1", 5_000L);
  }

  /** No wallet at all means no settled credit - a debit is insufficient, not a 500. */
  @Test
  void debitWithNoWalletIsInsufficient() {
    when(accounts.findByUserId("u1")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> service.debitForOrder("u1", "o1", new Money(1, "USD"), "idem-5"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.INSUFFICIENT_BALANCE);

    verify(grants, never()).revokeWalletGrantsMostRecentFirst(anyString(), anyLong());
  }
}
