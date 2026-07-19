package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Gate 1: structural + enum validation against {@code skill-manifest.schema.json} (draft 2020-12).
 * The schema is closed ({@code additionalProperties/unevaluatedProperties:false}, closed
 * tool/capability/widget enums), so this alone catches unknown tools, unknown widget types, forbidden
 * capabilities (network/file/system), remote/non-SVG assets, bad semver, and missing required fields.
 * The schema is self-contained (no external {@code $ref}), so no reference registry is needed.
 */
public final class SchemaValidationCheck implements CertificationCheck {

  private final JsonSchema schema;

  public SchemaValidationCheck(JsonNode schemaNode) {
    JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
    this.schema = factory.getSchema(schemaNode);
  }

  @Override
  public String name() {
    return "schema";
  }

  @Override
  public List<Finding> run(JsonNode manifest) {
    Set<ValidationMessage> messages = schema.validate(manifest);
    List<Finding> findings = new ArrayList<>(messages.size());
    for (ValidationMessage m : messages) {
      findings.add(
          Finding.error("schema_violation", m.getMessage(), m.getInstanceLocation().toString()));
    }
    return findings;
  }
}
