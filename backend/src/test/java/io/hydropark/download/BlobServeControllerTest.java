package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.nio.charset.StandardCharsets;
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

  @BeforeEach
  void setUp(@TempDir Path tempDir) {
    props = new BlobStoreProperties();
    props.setHmacSecret("test-secret");
    props.setBaseUrl("http://localhost:8080/blobs");
    props.setLocalRoot(tempDir.toString());
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
  void controllerTreatsATraversalKeyAsNotFoundRatherThanEscapingTheRoot() {
    // Exercised as a direct call (not through MockMvc's URL parsing, whose own normalization of
    // ".." segments is a separate, uncontrolled variable) to pin down the controller's own guard:
    // a syntactically valid signature over a traversal key must still 404, never read outside root.
    String traversalKey = "../outside.txt";
    long exp = Instant.now().plusSeconds(300).getEpochSecond();
    String sig = store.sign(traversalKey, SCOPE, exp);

    ResponseEntity<Resource> res = controller.serve(traversalKey, SCOPE, exp, sig);

    assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
  }

  private static String queryOf(SignedUrl signed) {
    String url = signed.url();
    return url.substring(url.indexOf('?') + 1);
  }
}
