package io.hydropark.catalog.dto;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.catalog.Skill;
import io.hydropark.common.Money;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * SF8 / P1-13.3 AC: the full {@code system_prompt} is paid IP that lives only inside the signed
 * {@code .hpskill} package and must never reach a catalog response. Not run as part of this change
 * (AGENT-CONTRACT: "Do not run mvn").
 */
class SkillDetailDtoNoSystemPromptTest {

  @Test
  void skillDetailDtoDeclaresNoSystemPromptField() {
    assertThat(fieldNamesLookingLikeSystemPrompt(SkillDetailDto.class))
        .as("SkillDetailDto must never carry the full system_prompt (SF8)")
        .isEmpty();
  }

  @Test
  void catalogItemDtoDeclaresNoSystemPromptField() {
    assertThat(fieldNamesLookingLikeSystemPrompt(CatalogItemDto.class)).isEmpty();
  }

  @Test
  void skillEntityDeclaresNoSystemPromptField() {
    // The document class backing `skills` - the field must not exist here either, so nobody can
    // "temporarily" wire it through to a DTO later without first re-adding it here, which this
    // test would catch.
    assertThat(fieldNamesLookingLikeSystemPrompt(Skill.class))
        .as("the skills document must never carry system_prompt (BE §3.2 SF8)")
        .isEmpty();
  }

  @Test
  void serializedSkillDetailNeverMentionsSystemPromptEvenWhenEveryOtherFieldIsPopulated() throws Exception {
    SkillDetailDto dto =
        new SkillDetailDto(
            "cooking-assistant",
            "Cooking Assistant",
            "home",
            false,
            "published",
            new Money(500, "USD"),
            "You help the user cook. Ask about dietary restrictions first.",
            true,
            "small",
            new RequirementsDto("small", "1.0.0"),
            new SkillVersionDto("1.2.0", "1.0.0", 1024L, "deadbeef", true, "notes", "published"),
            "notes",
            Boolean.TRUE,
            List.of("timers", "unit_conversion", "list_management"));

    String json = new ObjectMapper().writeValueAsString(dto);

    assertThat(json).doesNotContainIgnoringCase("system_prompt");
    assertThat(json).doesNotContainIgnoringCase("systemPrompt");
    // sanity: the field that IS allowed to carry persona text is present, so this test would have
    // caught a missing/renamed getter rather than passing vacuously.
    assertThat(json).contains("compressed_prompt");
  }

  private static List<String> fieldNamesLookingLikeSystemPrompt(Class<?> type) {
    return Arrays.stream(type.getDeclaredFields())
        .map(Field::getName)
        .filter(SkillDetailDtoNoSystemPromptTest::looksLikeSystemPrompt)
        .toList();
  }

  private static boolean looksLikeSystemPrompt(String fieldName) {
    String normalized = fieldName.toLowerCase();
    return normalized.equals("systemprompt") || normalized.contains("system_prompt");
  }
}
