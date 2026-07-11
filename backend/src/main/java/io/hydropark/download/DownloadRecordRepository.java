package io.hydropark.download;

import java.util.List;
import org.springframework.data.mongodb.repository.MongoRepository;

/** Spring Data access for {@code download_records} (watermark buyer-tokens, P1-19.2). */
public interface DownloadRecordRepository extends MongoRepository<DownloadRecord, String> {

  /** A user's download history - the GDPR erasure scrub (P1-12.6) deletes exactly these. */
  List<DownloadRecord> findByUserId(String userId);

  /** Leak tracing: recover the buyer(s) behind a watermark lifted from a leaked package. */
  List<DownloadRecord> findByWatermarkToken(String watermarkToken);
}
