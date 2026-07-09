package io.hydropark.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

/**
 * BE §4.2 N1 / P1-13.4 AC: the preview endpoint must never accept client-supplied prompt text -
 * that would turn it into a free inference oracle over the paid persona. Asserted structurally
 * (reflection over the controller method), not just behaviourally, so a future edit that adds a
 * parameter here fails a test rather than silently reopening the extraction hole. Not run as part
 * of this change (AGENT-CONTRACT: "Do not run mvn").
 */
class CatalogControllerPreviewTest {

  @Test
  void previewEndpointHasExactlyOneParameterAndItIsTheSkillIdPathVariable() throws NoSuchMethodException {
    Method preview = CatalogController.class.getMethod("preview", String.class);
    Parameter[] params = preview.getParameters();

    assertThat(params).hasSize(1);
    assertThat(params[0].isAnnotationPresent(PathVariable.class)).isTrue();
  }

  @Test
  void noOverloadOfPreviewAcceptsAnAdditionalArgument() {
    long previewMethodCount =
        Arrays.stream(CatalogController.class.getMethods())
            .filter(m -> m.getName().equals("preview"))
            .count();

    assertThat(previewMethodCount).isEqualTo(1);
  }

  @Test
  void previewMethodHasNoRequestParamOrRequestBodyAnnotationAnywhere() throws NoSuchMethodException {
    Method preview = CatalogController.class.getMethod("preview", String.class);
    for (Parameter p : preview.getParameters()) {
      assertThat(p.isAnnotationPresent(RequestParam.class)).isFalse();
      assertThat(p.isAnnotationPresent(RequestBody.class)).isFalse();
    }
  }
}
