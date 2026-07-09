package io.hydropark.commerce;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.MongoWriteException;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.function.Supplier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

/**
 * Appendix A - idempotency keyed by {@code (user_id, endpoint, key)}, ~24h TTL. The first response is
 * stored and replayed verbatim, so a retried mutating call never double-charges/grants/debits.
 *
 * <p>The placeholder insert is the claim: because the composite key is the document {@code _id}, a
 * concurrent duplicate collides on insert rather than racing a read-then-write. A completed record
 * replays; an in-flight one returns {@code IDEMPOTENCY_REPLAY} (409). If the action fails, the
 * placeholder is removed so the client may legitimately retry.
 */
@Service
public class IdempotencyService {

  private static final long TTL_HOURS = 24;

  private final MongoTemplate mongo;
  private final ObjectMapper mapper;

  public IdempotencyService(MongoTemplate mongo, ObjectMapper mapper) {
    this.mongo = mongo;
    this.mapper = mapper;
  }

  /**
   * Runs {@code action} at most once per {@code (userId, endpoint, key)}. A null/blank key disables
   * idempotency (the action simply runs). {@code action} returns the response body object.
   */
  public ResponseEntity<Object> execute(
      String userId, String endpoint, String key, HttpStatus successStatus, Supplier<Object> action) {
    if (key == null || key.isBlank()) {
      return ResponseEntity.status(successStatus).body(action.get());
    }

    String id = IdempotencyRecord.compositeId(userId, endpoint, key);
    Instant now = Instant.now();
    IdempotencyRecord placeholder =
        new IdempotencyRecord(userId, endpoint, key, now, now.plus(TTL_HOURS, ChronoUnit.HOURS));

    try {
      mongo.insert(placeholder);
    } catch (DuplicateKeyException | MongoWriteException dup) {
      IdempotencyRecord existing = mongo.findById(id, IdempotencyRecord.class);
      if (existing != null && existing.isCompleted()) {
        HttpStatus status =
            existing.getResponseStatus() != null
                ? HttpStatus.valueOf(existing.getResponseStatus())
                : successStatus;
        return ResponseEntity.status(status).body(existing.getResponseBody());
      }
      throw new ApiException(
          ErrorCode.IDEMPOTENCY_REPLAY, "a request with this Idempotency-Key is already in flight");
    }

    try {
      Object result = action.get();
      Object body = result == null ? null : mapper.convertValue(result, Object.class);
      mongo.updateFirst(
          Query.query(Criteria.where("id").is(id)),
          new Update()
              .set("completed", true)
              .set("responseStatus", successStatus.value())
              .set("responseBody", body),
          IdempotencyRecord.class);
      return ResponseEntity.status(successStatus).body(result);
    } catch (RuntimeException e) {
      // A failed attempt must not permanently occupy the key.
      mongo.remove(Query.query(Criteria.where("id").is(id)), IdempotencyRecord.class);
      throw e;
    }
  }
}
