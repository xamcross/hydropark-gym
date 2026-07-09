package io.hydropark.catalog;

import com.mongodb.ReadPreference;
import io.hydropark.catalog.dto.BundleDetailDto;
import io.hydropark.catalog.dto.BundleMemberDto;
import io.hydropark.catalog.dto.CatalogItemDto;
import io.hydropark.catalog.dto.PreviewDto;
import io.hydropark.catalog.dto.RequirementsDto;
import io.hydropark.catalog.dto.SkillDetailDto;
import io.hydropark.catalog.dto.SkillVersionDto;
import io.hydropark.common.ApiException;
import io.hydropark.common.CursorPage;
import io.hydropark.common.Money;
import io.hydropark.port.Ports;
import io.hydropark.security.AuthPrincipal;
import io.hydropark.security.CurrentUser;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

/**
 * Read side of BACKLOG P1-13 (BE §4.2). Every endpoint here is public/optionally-authed and
 * cacheable; nothing in this class mutates catalog data.
 *
 * <p>Never calls another domain package directly (AGENT-CONTRACT): ownership annotation goes
 * through the injected {@link Ports.GrantPort}, pricing through this package's own {@link
 * Ports.PricingPort}.
 */
@Service
public class CatalogService {

  private final MongoTemplate mongo;
  private final SkillRepository skills;
  private final SkillVersionRepository skillVersions;
  private final BundleRepository bundles;
  private final BundleMemberRepository bundleMembers;
  private final Ports.PricingPort pricing;
  private final Ports.GrantPort grants;

  public CatalogService(
      MongoTemplate mongo,
      SkillRepository skills,
      SkillVersionRepository skillVersions,
      BundleRepository bundles,
      BundleMemberRepository bundleMembers,
      Ports.PricingPort pricing,
      Ports.GrantPort grants) {
    this.mongo = mongo;
    this.skills = skills;
    this.skillVersions = skillVersions;
    this.bundles = bundles;
    this.bundleMembers = bundleMembers;
    this.pricing = pricing;
    this.grants = grants;
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/catalog
  // ---------------------------------------------------------------------------------------------

  /**
   * Cursor-paginated skills + bundles, merged and sorted by id (BE §4.2).
   *
   * <p>Fetches up to {@code limit + 1} rows from <em>each</em> collection (a standard k-way-merge
   * cursor technique): after merging and re-sorting, the true next page can never need more than
   * that from either side. Reads target an Atlas secondary (P1-13.2 AC) - eventual consistency is
   * accepted for a public, cacheable listing.
   */
  public CursorPage<CatalogItemDto> listCatalog(Integer limit, String cursor, String region) {
    int lim = CursorPage.clampLimit(limit);
    String after = CursorPage.decode(cursor);

    Query skillQuery = Query.query(Criteria.where("status").is(CatalogStatus.PUBLISHED.wire()));
    if (after != null) {
      skillQuery.addCriteria(Criteria.where("id").gt(after));
    }
    skillQuery.with(Sort.by(Sort.Direction.ASC, "id")).limit(lim + 1);
    skillQuery.withReadPreference(ReadPreference.secondaryPreferred());
    List<Skill> pageSkills = mongo.find(skillQuery, Skill.class);

    Query bundleQuery = Query.query(Criteria.where("status").is(CatalogStatus.PUBLISHED.wire()));
    if (after != null) {
      bundleQuery.addCriteria(Criteria.where("id").gt(after));
    }
    bundleQuery.with(Sort.by(Sort.Direction.ASC, "id")).limit(lim + 1);
    bundleQuery.withReadPreference(ReadPreference.secondaryPreferred());
    List<Bundle> pageBundles = mongo.find(bundleQuery, Bundle.class);

    List<CatalogEntry> merged = new ArrayList<>(pageSkills.size() + pageBundles.size());
    pageSkills.forEach(s -> merged.add(new CatalogEntry(s.getId(), s, null)));
    pageBundles.forEach(b -> merged.add(new CatalogEntry(b.getId(), null, b)));
    merged.sort(Comparator.comparing(CatalogEntry::id));

    Map<String, SkillVersion> currentBySkill =
        skillVersions.findBySkillIdInAndCurrentTrue(pageSkills.stream().map(Skill::getId).toList())
            .stream()
            .collect(Collectors.toMap(SkillVersion::getSkillId, v -> v));

    AuthPrincipal user = CurrentUser.orNull();

    CursorPage<CatalogEntry> page = CursorPage.from(merged, lim, CatalogEntry::id);
    List<CatalogItemDto> items =
        page.items().stream().map(e -> toItemDto(e, region, currentBySkill, user)).toList();
    return new CursorPage<>(items, page.nextCursor());
  }

  private CatalogItemDto toItemDto(
      CatalogEntry entry, String region, Map<String, SkillVersion> currentBySkill, AuthPrincipal user) {
    if (entry.skill() != null) {
      Skill s = entry.skill();
      Money price = pricing.quote(Ports.PurchaseKind.SKILL, s.getId(), region);
      SkillVersion current = currentBySkill.get(s.getId());
      Boolean owned = user == null ? null : grants.hasActiveGrant(user.userId(), s.getId());
      return new CatalogItemDto(
          "skill",
          s.getId(),
          s.getName(),
          s.getCategory(),
          price,
          s.isFree(),
          new RequirementsDto(s.getMinModelTier(), current == null ? null : current.getMinAppVersion()),
          current == null ? null : current.getPackageBytes(),
          current == null ? null : current.getVersion(),
          owned);
    } else {
      Bundle b = entry.bundle();
      Money price = pricing.quote(Ports.PurchaseKind.BUNDLE, b.getId(), region);
      Boolean owned = user == null ? null : isBundleOwned(user.userId(), b.getId());
      return new CatalogItemDto("bundle", b.getId(), b.getName(), null, price, false, null, null, null, owned);
    }
  }

  /** Internal merge helper - exactly one of {@code skill}/{@code bundle} is non-null. */
  private record CatalogEntry(String id, Skill skill, Bundle bundle) {}

  // ---------------------------------------------------------------------------------------------
  // GET /v1/catalog/skills/{skillId}
  // ---------------------------------------------------------------------------------------------

  public SkillDetailDto getSkillDetail(String skillId, String region) {
    Skill skill = skills.findById(skillId).orElseThrow(() -> ApiException.notFound("skill " + skillId));
    SkillVersion current = skillVersions.findBySkillIdAndCurrentTrue(skillId).orElse(null);
    Money price = pricing.quote(Ports.PurchaseKind.SKILL, skillId, region);

    AuthPrincipal user = CurrentUser.orNull();
    Boolean owned = user == null ? null : grants.hasActiveGrant(user.userId(), skillId);

    boolean hasPreview =
        skill.getPreviewTranscriptUri() != null && !skill.getPreviewTranscriptUri().isBlank();
    RequirementsDto requirements =
        new RequirementsDto(skill.getMinModelTier(), current == null ? null : current.getMinAppVersion());
    SkillVersionDto currentDto = current == null ? null : toVersionDto(current);

    return new SkillDetailDto(
        skill.getId(),
        skill.getName(),
        skill.getCategory(),
        skill.isFree(),
        skill.getStatus(),
        price,
        skill.getCompressedPrompt(),
        hasPreview,
        skill.getMinModelTier(),
        requirements,
        currentDto,
        current == null ? null : current.getChangelog(),
        owned);
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/catalog/skills/{skillId}/versions
  // ---------------------------------------------------------------------------------------------

  public CursorPage<SkillVersionDto> listVersions(String skillId, Integer limit, String cursor) {
    if (!skills.existsById(skillId)) {
      throw ApiException.notFound("skill " + skillId);
    }
    int lim = CursorPage.clampLimit(limit);
    String after = CursorPage.decode(cursor);

    Query q = Query.query(Criteria.where("skillId").is(skillId));
    if (after != null) {
      q.addCriteria(Criteria.where("id").gt(after));
    }
    // UUIDv7 ids are time-ordered, so sorting by id also sorts by creation order.
    q.with(Sort.by(Sort.Direction.ASC, "id")).limit(lim + 1);
    List<SkillVersion> rows = mongo.find(q, SkillVersion.class);

    CursorPage<SkillVersion> raw = CursorPage.from(rows, lim, SkillVersion::getId);
    return new CursorPage<>(raw.items().stream().map(this::toVersionDto).toList(), raw.nextCursor());
  }

  private SkillVersionDto toVersionDto(SkillVersion v) {
    return new SkillVersionDto(
        v.getVersion(),
        v.getMinAppVersion(),
        v.getPackageBytes(),
        v.getPackageSha256(),
        v.isCurrent(),
        v.getChangelog(),
        v.getStatus());
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/catalog/bundles/{bundleId}
  // ---------------------------------------------------------------------------------------------

  public BundleDetailDto getBundleDetail(String bundleId, String region) {
    Bundle bundle = bundles.findById(bundleId).orElseThrow(() -> ApiException.notFound("bundle " + bundleId));
    List<BundleMember> members = bundleMembers.findByBundleId(bundleId);
    List<String> skillIds = members.stream().map(BundleMember::getSkillId).toList();

    Map<String, Skill> skillsById =
        skills.findAllById(skillIds).stream().collect(Collectors.toMap(Skill::getId, s -> s));

    Money bundlePrice = pricing.quote(Ports.PurchaseKind.BUNDLE, bundleId, region);

    List<BundleMemberDto> memberDtos = new ArrayList<>();
    long sum = 0;
    for (String skillId : skillIds) {
      Skill s = skillsById.get(skillId);
      if (s == null) {
        // regional_prices/bundle_members are polymorphic with no FK (BE §11.2 #3): a dangling
        // member is a content-authoring bug, not a client error - skip it rather than 500ing the
        // whole bundle page.
        continue;
      }
      Money memberPrice = pricing.quote(Ports.PurchaseKind.SKILL, skillId, region);
      memberDtos.add(new BundleMemberDto(skillId, s.getName(), s.getCategory(), memberPrice));
      if (!memberPrice.sameCurrencyAs(bundlePrice)) {
        throw ApiException.validation(
            "bundle " + bundleId + " mixes currencies across members for region " + region);
      }
      sum += memberPrice.amount();
    }
    Money memberPriceSum = new Money(sum, bundlePrice.currency());
    Money savings = new Money(Math.max(0, sum - bundlePrice.amount()), bundlePrice.currency());

    AuthPrincipal user = CurrentUser.orNull();
    Boolean owned =
        user == null
            ? null
            : !skillIds.isEmpty() && skillIds.stream().allMatch(id -> grants.hasActiveGrant(user.userId(), id));

    return new BundleDetailDto(
        bundle.getId(), bundle.getName(), bundle.getStatus(), bundlePrice, memberPriceSum, savings, memberDtos, owned);
  }

  private boolean isBundleOwned(String userId, String bundleId) {
    List<BundleMember> members = bundleMembers.findByBundleId(bundleId);
    return !members.isEmpty() && members.stream().allMatch(m -> grants.hasActiveGrant(userId, m.getSkillId()));
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/catalog/skills/{skillId}/preview
  // ---------------------------------------------------------------------------------------------

  /**
   * BE §4.2 N1 / SPEC §11.4 - extraction-hardened by construction: this method takes no prompt
   * parameter of any kind, so there is no argument path by which client input could reach a model.
   * It serves only the curated {@code preview_transcript_uri} (SPEC §11.4: "Preview runs from the
   * skill's manifest + a demo transcript; no license is issued until purchase" - v1 has no live
   * generation at all). There is no LLM-inference {@code Ports} interface in this codebase, so the
   * "fixed, server-chosen prompt set -> live generation" branch BACKEND-DESIGN §4.2 N1 also
   * describes is out of scope here; see the final report.
   */
  public PreviewDto getPreview(String skillId) {
    Skill skill = skills.findById(skillId).orElseThrow(() -> ApiException.notFound("skill " + skillId));
    String uri = skill.getPreviewTranscriptUri();
    if (uri == null || uri.isBlank()) {
      throw ApiException.notFound("preview for skill " + skillId);
    }
    return new PreviewDto(uri);
  }
}
