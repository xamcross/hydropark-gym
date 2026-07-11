package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.catalog.Skill;
import io.hydropark.catalog.SkillVersion;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.port.Ports;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;

/**
 * Entitlement gating and side effects of the download issuer (P1-19.2/.3). Mockito only - catalog
 * reads are stubbed on {@link MongoTemplate}, ownership on {@link Ports.GrantPort}; a real
 * {@link LocalFsBlobStore} produces the URL so the signed shape is exercised end to end. No Docker.
 */
class DownloadServiceTest {

  private final MongoTemplate mongo = mock(MongoTemplate.class);
  private final Ports.GrantPort grants = mock(Ports.GrantPort.class);
  private final DownloadRecordRepository records = mock(DownloadRecordRepository.class);
  private final EgressMeter egress = mock(EgressMeter.class);
  private final BlobStoreProperties props = props();
  private final BlobStore blobStore = new LocalFsBlobStore(props);

  private final DownloadService service =
      new DownloadService(mongo, grants, blobStore, props, records, egress);

  private static BlobStoreProperties props() {
    BlobStoreProperties p = new BlobStoreProperties();
    p.setHmacSecret("test-secret");
    p.setBaseUrl("https://cdn.example/blobs");
    return p;
  }

  private static Skill skill(String id, boolean free) {
    Skill s = new Skill();
    s.setId(id);
    s.setFree(free);
    return s;
  }

  private static SkillVersion version(String skillId, String version, String uri, long bytes) {
    SkillVersion v = new SkillVersion();
    v.setSkillId(skillId);
    v.setVersion(version);
    v.setPackageUri(uri);
    v.setPackageBytes(bytes);
    return v;
  }

  @Test
  void entitledPaidSkillIssuesUrlAndWritesWatermarkRecordAndMetersEgress() {
    when(mongo.findById("cooking", Skill.class)).thenReturn(skill("cooking", false));
    when(grants.hasActiveGrant("u1", "cooking")).thenReturn(true);
    when(mongo.findOne(any(Query.class), eq(SkillVersion.class)))
        .thenReturn(version("cooking", "1.2.0", "skills/cooking/1.2.0/pkg.hpskill", 4096L));

    SkillDownloadResponse res = service.issueSkillDownload("u1", "cooking", "1.2.0");

    // URL is short-TTL and user-scoped; watermark is present.
    assertThat(res.url()).contains("skills/cooking/1.2.0/pkg.hpskill").contains("scope=u1");
    assertThat(res.expiresAt()).isNotNull();
    assertThat(res.watermark()).isNotBlank();

    // The watermark buyer-token is persisted verbatim (the row feeds the GDPR scrub / leak tracing).
    ArgumentCaptor<DownloadRecord> saved = ArgumentCaptor.forClass(DownloadRecord.class);
    verify(records).save(saved.capture());
    DownloadRecord rec = saved.getValue();
    assertThat(rec.getUserId()).isEqualTo("u1");
    assertThat(rec.getSkillId()).isEqualTo("cooking");
    assertThat(rec.getVersion()).isEqualTo("1.2.0");
    assertThat(rec.getWatermarkToken()).isEqualTo(res.watermark());
    assertThat(rec.getIssuedAt()).isNotNull();

    verify(egress).record("u1", "skill", "skills/cooking/1.2.0/pkg.hpskill", 4096L);
  }

  @Test
  void freeSkillIsDeliveredWithoutConsultingGrants() {
    when(mongo.findById("hello", Skill.class)).thenReturn(skill("hello", true));
    when(mongo.findOne(any(Query.class), eq(SkillVersion.class)))
        .thenReturn(version("hello", "1.0.0", "skills/hello/1.0.0/pkg.hpskill", 10L));

    SkillDownloadResponse res = service.issueSkillDownload("u1", "hello", "1.0.0");

    assertThat(res.url()).isNotBlank();
    verify(grants, never()).hasActiveGrant(anyString(), anyString());
    verify(records).save(any(DownloadRecord.class));
  }

  @Test
  void notEntitledPaidSkillIsForbiddenWithNoSideEffects() {
    when(mongo.findById("cooking", Skill.class)).thenReturn(skill("cooking", false));
    when(grants.hasActiveGrant("u1", "cooking")).thenReturn(false);

    assertThatThrownBy(() -> service.issueSkillDownload("u1", "cooking", "1.2.0"))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.NOT_ENTITLED));

    // No URL, no watermark row, no egress - and it never even looks up the version (403 before 404).
    verify(records, never()).save(any());
    verify(egress, never()).record(any(), any(), any(), anyLong());
    verify(mongo, never()).findOne(any(Query.class), eq(SkillVersion.class));
  }

  @Test
  void unknownSkillIsNotFound() {
    when(mongo.findById("nope", Skill.class)).thenReturn(null);

    assertThatThrownBy(() -> service.issueSkillDownload("u1", "nope", "1.0.0"))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.NOT_FOUND));
    verify(records, never()).save(any());
  }

  @Test
  void unknownVersionForAnEntitledSkillIsNotFound() {
    when(mongo.findById("cooking", Skill.class)).thenReturn(skill("cooking", true));
    when(mongo.findOne(any(Query.class), eq(SkillVersion.class))).thenReturn(null);

    assertThatThrownBy(() -> service.issueSkillDownload("u1", "cooking", "9.9.9"))
        .isInstanceOf(ApiException.class)
        .satisfies(e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.NOT_FOUND));
    verify(records, never()).save(any());
  }

  @Test
  void modelDownloadIsPublicScopeCacheableAndWritesNoWatermarkRecord() {
    ModelDownloadResponse res = service.issueModelDownload("qwen2.5-3b-q4");

    assertThat(res.url()).contains("models/qwen2.5-3b-q4.gguf").contains("scope=public");
    assertThat(res.expiresAt()).isNotNull();
    verify(records, never()).save(any());
    verify(egress).record(isNull(), eq("model"), eq("models/qwen2.5-3b-q4.gguf"), anyLong());
  }

  @Test
  void modelIdWithPathTraversalIsRejected() {
    assertThatThrownBy(() -> service.issueModelDownload("../secrets/key"))
        .isInstanceOf(ApiException.class)
        .satisfies(
            e -> assertThat(((ApiException) e).errorCode()).isEqualTo(ErrorCode.VALIDATION_ERROR));
    verify(egress, never()).record(any(), any(), any(), anyLong());
  }
}
