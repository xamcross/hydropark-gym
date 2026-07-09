package io.hydropark.common;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

/**
 * §4 - every list endpoint is cursor-paginated: {@code ?limit=&cursor=} ->
 * {@code { items: [...], next_cursor: <opaque|null> }}.
 *
 * <p>The cursor is the last item's sort key, base64url-encoded so clients treat it as opaque.
 * UUIDv7 ids are time-sortable, which is why they double as the cursor for id-ordered collections.
 */
public record CursorPage<T>(List<T> items, String nextCursor) {

  public static final int DEFAULT_LIMIT = 50;
  public static final int MAX_LIMIT = 200;

  public static int clampLimit(Integer requested) {
    if (requested == null || requested <= 0) {
      return DEFAULT_LIMIT;
    }
    return Math.min(requested, MAX_LIMIT);
  }

  public static String encode(String rawSortKey) {
    if (rawSortKey == null) {
      return null;
    }
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(rawSortKey.getBytes(StandardCharsets.UTF_8));
  }

  public static String decode(String cursor) {
    if (cursor == null || cursor.isBlank()) {
      return null;
    }
    try {
      return new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      throw ApiException.validation("malformed cursor");
    }
  }

  /**
   * Builds a page from {@code limit + 1} rows: the extra row proves another page exists without a
   * count query.
   */
  public static <T> CursorPage<T> from(List<T> overFetched, int limit, java.util.function.Function<T, String> sortKey) {
    if (overFetched.size() <= limit) {
      return new CursorPage<>(overFetched, null);
    }
    List<T> page = overFetched.subList(0, limit);
    return new CursorPage<>(List.copyOf(page), encode(sortKey.apply(page.get(page.size() - 1))));
  }
}
