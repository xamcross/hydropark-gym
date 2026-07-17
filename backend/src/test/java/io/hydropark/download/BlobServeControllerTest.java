package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * The dev CDN edge (P1-19): a URL {@link LocalFsBlobStore} minted must round-trip through {@link
 * BlobServeController} to real bytes, and nothing else must. Real temp dir, real HMAC, real files
 * on disk - the controller is wired via {@code MockMvc.standaloneSetup}, no Spring context, no
 * mocked signature logic (AGENT-CONTRACT).
 */
class BlobServeControllerTest {

  private static final byte[] CONTENT = "hello hydropark blob bytes".getBytes(StandardCharsets.UTF_8);
  private static final String KEY = "skills/cooking/1.2.0/package.hpskill";
  private static final String SCOPE = "user-1";

  private BlobStoreProperties props;
  private LocalFsBlobStore store;
  private BlobServeController controller;
  private MockMvc mvc;
  /** The JUnit-managed temp dir itself - {@code local-root} is a subdirectory of it, so anything
   * written directly into this (not into {@code local-root}) is genuinely outside the served root. */
  private Path outsideRootDir;

  @BeforeEach
  void setUp(@TempDir Path tempDir) throws IOException {
    outsideRootDir = tempDir;
    Path root = tempDir.resolve("blobroot");
    Files.createDirectories(root);

    props = new BlobStoreProperties();
    props.setHmacSecret("test-secret");
    props.setBaseUrl("http://localhost:8080/blobs");
    props.setLocalRoot(root.toString());
    store = new LocalFsBlobStore(props);
    controller = new BlobServeController(store);
    mvc = MockMvcBuilders.standaloneSetup(controller).build();
  }

  @Test
  void servesStoredBytesForAValidlySignedUrl() throws Exception {
    store.store(KEY, CONTENT);
    SignedUrl signed = store.signedUrl(KEY, SCOPE, Duration.ofMinutes(5));

    MockHttpServletResponse res =
        mvc.perform(get("/blobs/" + KEY + "?" + queryOf(signed))).andReturn().getResponse();

    assertThat(res.getStatus()).isEqualTo(200);
    assertThat(res.getContentAsByteArray()).isEqualTo(CONTENT);
    assertThat(res.getContentLength()).isEqualTo(CONTENT.length);
  }

  @Test
  void tamperedSignatureIsForbidden() throws Exception {
    store.store(KEY, CONTENT);
    SignedUrl signed = store.signedUrl(KEY, SCOPE, Duration.ofMinutes(5));
    String tamperedQuery = queryOf(signed).replaceAll("sig=[^&]+$", "sig=tampered-signature");

    MockHttpServletResponse res =
        mvc.perform(get("/blobs/" + KEY + "?" + tamperedQuery)).andReturn().getResponse();

    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void expiredSignatureIsForbidden() throws Exception {
    store.store(KEY, CONTENT);
    long expiredExp = Instant.now().minusSeconds(10).getEpochSecond();
    String sig = store.sign(KEY, SCOPE, expiredExp);
    String query = "scope=" + SCOPE + "&exp=" + expiredExp + "&sig=" + sig;

    MockHttpServletResponse res = mvc.perform(get("/blobs/" + KEY + "?" + query)).andReturn().getResponse();

    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void unknownPathWithAValidSignatureShapeIsNotFound() throws Exception {
    // Never stored - the signature over this key is otherwise perfectly valid.
    String ghostKey = "skills/ghost/9.9.9/package.hpskill";
    SignedUrl signed = store.signedUrl(ghostKey, SCOPE, Duration.ofMinutes(5));

    MockHttpServletResponse res =
        mvc.perform(get("/blobs/" + ghostKey + "?" + queryOf(signed))).andReturn().getResponse();

    assertThat(res.getStatus()).isEqualTo(404);
  }

  @Test
  void resolveRejectsPathTraversalAndNeverEscapesTheRoot() {
    assertThatThrownBy(() -> store.resolve("../outside.txt"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> store.resolve("skills/../../outside.txt"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> store.resolve("../../../../../../etc/passwd"))
        .isInstanceOf(IllegalArgumentException.class);

    // An internal ".." that never climbs above the root is not a traversal - it just lands in a
    // nested directory, same as it would on a real filesystem.
    assertThat(store.resolve("skills/../models/qwen.gguf")).isEqualTo(store.resolve("models/qwen.gguf"));
  }

  @Test
  void resolveRejectsBackslashComposedTraversal() {
    // objectKey.replace('\\', '/') (LocalFsBlobStore#resolve) turns "..\..\sentinel" into
    // "../../sentinel" before the same escape check runs - a Windows-style key must be contained
    // exactly like its forward-slash equivalent, not slip through because the separator differs.
    assertThatThrownBy(() -> store.resolve("..\\..\\sentinel"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> store.resolve("skills\\..\\..\\sentinel"))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void controllerTreatsATraversalKeyAsNotFoundRatherThanEscapingTheRoot() {
    // Exercised as a direct call to deterministically pin the controller's OWN guard in isolation
    // from container/dispatch behavior. The two HTTP-level tests below additionally drive the same
    // property end-to-end through real MockMvc dispatch, where container/pattern-matching behavior
    // for ".." segments is a separate variable this test intentionally does not depend on.
    String traversalKey = "../outside.txt";
    long exp = Instant.now().plusSeconds(300).getEpochSecond();
    String sig = store.sign(traversalKey, SCOPE, exp);

    ResponseEntity<Resource> res = controller.serve(traversalKey, SCOPE, exp, sig);

    assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
  }

  @Test
  void urlEncodedTraversalNeverReturnsTheOutsideRootSentinel() throws Exception {
    // Sentinel lives directly in the JUnit temp dir, one level above local-root ("blobroot") -
    // genuinely outside the served root, not just an unstored key inside it.
    byte[] sentinelBytes = "TOP-SECRET-OUTSIDE-ROOT-A".getBytes(StandardCharsets.UTF_8);
    Files.write(outsideRootDir.resolve("outside-secret-a.txt"), sentinelBytes);

    String traversalKey = "../outside-secret-a.txt";
    long exp = Instant.now().plusSeconds(300).getEpochSecond();
    String sig = store.sign(traversalKey, SCOPE, exp);
    String query = "scope=" + SCOPE + "&exp=" + exp + "&sig=" + sig;
    // "%2e%2e%2f" is the percent-encoded form of "../" - composed so the traversal segment
    // survives as encoded octets in the raw request line rather than as literal dots, exercising
    // whatever decode/normalize step Spring's dispatch applies before our handler ever sees it.
    String encodedTraversalSegment = "%2e%2e%2foutside-secret-a.txt";

    MockHttpServletResponse res =
        mvc.perform(get("/blobs/" + encodedTraversalSegment + "?" + query)).andReturn().getResponse();

    // Status-agnostic by design (per review): whichever layer rejects an encoded ".." segment -
    // Spring's own dispatch/pattern-matching, or our resolve() guard once routed through - the
    // one property that must hold is "never a 200 carrying the sentinel's bytes". See the fix
    // section in task-7-report.md for the actually-observed status from the lead's verification
    // run; this assertion intentionally does not hardcode one exact code so it doesn't build in a
    // guess about container-normalization behavior I could not execute mvn to confirm myself.
    assertThat(res.getStatus()).isNotEqualTo(200);
    assertThat(res.getContentAsByteArray()).isNotEqualTo(sentinelBytes);
  }

  @Test
  void literalDotDotSegmentNeverReturnsTheOutsideRootSentinel() throws Exception {
    byte[] sentinelBytes = "TOP-SECRET-OUTSIDE-ROOT-B".getBytes(StandardCharsets.UTF_8);
    Files.write(outsideRootDir.resolve("outside-secret-b.txt"), sentinelBytes);

    String traversalKey = "../outside-secret-b.txt";
    long exp = Instant.now().plusSeconds(300).getEpochSecond();
    String sig = store.sign(traversalKey, SCOPE, exp);
    String query = "scope=" + SCOPE + "&exp=" + exp + "&sig=" + sig;

    MockHttpServletResponse res =
        mvc.perform(get("/blobs/" + traversalKey + "?" + query)).andReturn().getResponse();

    // Same status-agnostic property as above, this time with a literal (unencoded) ".." segment
    // in the raw request path.
    assertThat(res.getStatus()).isNotEqualTo(200);
    assertThat(res.getContentAsByteArray()).isNotEqualTo(sentinelBytes);
  }

  private static String queryOf(SignedUrl signed) {
    String url = signed.url();
    return url.substring(url.indexOf('?') + 1);
  }
}
