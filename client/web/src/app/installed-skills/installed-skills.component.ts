import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { InstalledSkillView } from '../ipc/contract';
import { EnabledSkillsService } from '../composition/enabled-skills.service';

/**
 * The two P0 skills ship built into the app rather than through the
 * `.hpskill` install pipeline — `hpskill.rs` never calls
 * `store::save_installed_skill` for them (see `main.rs`'s
 * `skills_list_installed_with_store` doc comment), so they never actually
 * appear in `skills_list_installed`'s result today. This set is a defensive
 * filter kept in sync with `SkillToggleComponent`'s hardcoded rows anyway, so
 * neither surface can ever render a duplicate toggle for the same skill.
 */
const P0_SKILL_IDS: ReadonlySet<string> = new Set(['kitchen-timer', 'cooking-assistant']);

/**
 * The W06 gap fix: installed skills beyond the two hardcoded P0 ones (e.g. a
 * just-installed free "Packing List") were invisible in the dashboard's skill
 * list and had no way to be enabled from there. This component reads the
 * on-device `installed_skills` registry (`skills_list_installed`, P1-03.2)
 * and renders one toggle row per non-P0 installed skill.
 *
 * ── the enable/disable seam ───────────────────────────────────────────────
 * The Rust `skill_enable`/`skill_disable` commands take the fixed 2-value P0
 * `SkillId` enum (see `ipc.rs`) and cannot deserialize an arbitrary
 * marketplace id — `PurchaseService.enable()` already established the real
 * seam for this exact class of skill: {@link EnabledSkillsService}, a
 * client-side enabled-id set that `CompositionService.enabledManifests`
 * unions into the live composed agent. This component reuses that SAME
 * service (not a new mechanism) so a toggle flipped here actually composes
 * the skill's persona/tools/panels, exactly like flipping it from the
 * Marketplace detail page's own "Enable" button does.
 *
 * ── refresh ────────────────────────────────────────────────────────────────
 * `app.component.html` mounts this component inside the `view() ===
 * 'assistant'` `@if` block, which Angular destroys/recreates on every tab
 * switch — so `ngOnInit` re-fetching on every mount satisfies "refresh after
 * an install completes" (install happens on the Marketplace tab; navigating
 * back to Assistant remounts this component) as well as "refresh on view
 * load", with no coupling into `purchase.service.ts`.
 */
@Component({
  selector: 'app-installed-skills',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './installed-skills.component.html',
  styleUrl: './installed-skills.component.css',
})
export class InstalledSkillsComponent implements OnInit {
  private readonly ipc = inject(IPC_PORT);
  readonly enabledSkills = inject(EnabledSkillsService);

  private readonly _skills = signal<InstalledSkillView[]>([]);
  /** Installed skills beyond the two hardcoded P0 ones, id-ascending (mirrors the store's own order). */
  readonly skills = this._skills.asReadonly();

  readonly loading = signal(false);

  ngOnInit(): void {
    void this.refresh();
  }

  /** Re-pull the installed-skill registry from the Rust core. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const rows = await this.ipc.invoke('skills_list_installed', undefined);
      this._skills.set(rows.filter((s) => !P0_SKILL_IDS.has(s.skill_id)));
    } finally {
      this.loading.set(false);
    }
  }

  toggle(skillId: string): void {
    this.enabledSkills.toggle(skillId);
  }

  trackSkill(_index: number, s: InstalledSkillView): string {
    return s.skill_id;
  }
}
