package io.hydropark.continuity;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * A dual-control business-continuity pre-mint batch (P1-23.1). The batch is the persisted record of a
 * <b>two-person rule</b>: before any license is minted, two <em>distinct</em> registry admins must
 * each record an approval. The approvals are stored here, in an append-only {@link #approvals} list,
 * so the control is auditable and survives a restart - the decision to mass-pre-sign licenses is never
 * a single operator's to make, and never the client's.
 *
 * <p>Lifecycle: {@link #STATUS_PENDING_APPROVAL} → (2 distinct approvals) → {@link #STATUS_APPROVED} →
 * (run) → {@link #STATUS_COMPLETED}. The mint step ({@code ContinuityBatchService.runApprovedBatch})
 * refuses to sign anything until the batch is {@link #STATUS_APPROVED}; a single approval mints
 * nothing.
 */
@Document(collection = "continuity_batches")
public class ContinuityBatch {

  public static final String STATUS_PENDING_APPROVAL = "pending_approval";
  public static final String STATUS_APPROVED = "approved";
  public static final String STATUS_COMPLETED = "completed";

  /** The two-person rule: two distinct admins must approve before any mint runs. */
  public static final int DEFAULT_REQUIRED_APPROVALS = 2;

  /** One recorded admin approval. Distinctness is enforced on {@code adminUserId}. */
  public static class Approval {
    @Field("admin_user_id")
    private String adminUserId;

    @Field("at")
    private Instant at;

    public Approval() {}

    public Approval(String adminUserId, Instant at) {
      this.adminUserId = adminUserId;
      this.at = at;
    }

    public String getAdminUserId() {
      return adminUserId;
    }

    public void setAdminUserId(String adminUserId) {
      this.adminUserId = adminUserId;
    }

    public Instant getAt() {
      return at;
    }

    public void setAt(Instant at) {
      this.at = at;
    }
  }

  @Id private String id;

  @Field("status")
  private String status;

  @Field("requested_by")
  private String requestedBy;

  @Field("requested_at")
  private Instant requestedAt;

  @Field("required_approvals")
  private int requiredApprovals;

  @Field("approvals")
  private List<Approval> approvals = new ArrayList<>();

  @Field("completed_at")
  private Instant completedAt;

  /** Filled after a run: how many licenses the batch actually minted through the Issuer. */
  @Field("minted_count")
  private int mintedCount;

  public ContinuityBatch() {}

  /** Open a fresh batch awaiting dual-control approval, requested by a named admin. */
  public static ContinuityBatch open(String requestedByAdminId, Instant now) {
    ContinuityBatch b = new ContinuityBatch();
    b.status = STATUS_PENDING_APPROVAL;
    b.requestedBy = requestedByAdminId;
    b.requestedAt = now;
    b.requiredApprovals = DEFAULT_REQUIRED_APPROVALS;
    b.approvals = new ArrayList<>();
    return b;
  }

  /** True iff {@code adminUserId} has already recorded an approval on this batch. */
  public boolean hasApprovalFrom(String adminUserId) {
    return approvals.stream().anyMatch(a -> a.getAdminUserId().equals(adminUserId));
  }

  /** The number of distinct admins who have approved (the list never holds a duplicate admin). */
  public int distinctApprovalCount() {
    return (int) approvals.stream().map(Approval::getAdminUserId).distinct().count();
  }

  /** The dual-control gate: enough distinct approvals to authorize the mint. */
  public boolean hasEnoughApprovals() {
    return distinctApprovalCount() >= requiredApprovals;
  }

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public String getRequestedBy() {
    return requestedBy;
  }

  public void setRequestedBy(String requestedBy) {
    this.requestedBy = requestedBy;
  }

  public Instant getRequestedAt() {
    return requestedAt;
  }

  public void setRequestedAt(Instant requestedAt) {
    this.requestedAt = requestedAt;
  }

  public int getRequiredApprovals() {
    return requiredApprovals;
  }

  public void setRequiredApprovals(int requiredApprovals) {
    this.requiredApprovals = requiredApprovals;
  }

  public List<Approval> getApprovals() {
    return approvals;
  }

  public void setApprovals(List<Approval> approvals) {
    this.approvals = approvals == null ? new ArrayList<>() : approvals;
  }

  public Instant getCompletedAt() {
    return completedAt;
  }

  public void setCompletedAt(Instant completedAt) {
    this.completedAt = completedAt;
  }

  public int getMintedCount() {
    return mintedCount;
  }

  public void setMintedCount(int mintedCount) {
    this.mintedCount = mintedCount;
  }
}
