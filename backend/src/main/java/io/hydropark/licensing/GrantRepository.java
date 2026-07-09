package io.hydropark.licensing;

import java.util.List;
import org.springframework.data.mongodb.repository.MongoRepository;

/** Spring Data access for {@code grants}. Joins the ambient settlement transaction automatically. */
public interface GrantRepository extends MongoRepository<Grant, String> {

  /** Effective entitlement probe. */
  boolean existsByUserIdAndSkillIdAndStatus(String userId, String skillId, String status);

  /** Active grants for an exact {@code (user, skill)} - the Issuer walks these for a settled order. */
  List<Grant> findByUserIdAndSkillIdAndStatus(String userId, String skillId, String status);

  /** All grants tied to an order - {@code flipGrantsForOrder} touches only these. */
  List<Grant> findByOrderId(String orderId);

  /** Every grant for a user - the entitlement view groups these by skill. */
  List<Grant> findByUserId(String userId);

  /**
   * The wallet clawback candidate order (§5.5 N5): currently-active, wallet-funded grants,
   * most-recent-first. {@code granted_at} desc with an {@code id} tie-break makes the walk fully
   * deterministic even when several grants share a creation instant (one bundle order).
   */
  List<Grant> findByUserIdAndPaymentSourceAndStatusOrderByGrantedAtDescIdDesc(
      String userId, String paymentSource, String status);
}
