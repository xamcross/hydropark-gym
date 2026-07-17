import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';
import { manifestFor } from '../composition/manifest-registry';
import { TemplateView } from '../ipc/contract';
import { PurchaseService } from '../marketplace/purchase.service';
import { TemplateLoadOutcome, TemplatesService } from './templates.service';

/**
 * "My Templates" gallery (Task 11b, SPEC §10). Lists saved templates (name +
 * skill chips) with a Load button per row. A `template_load` that resolves
 * `ok:false` renders the SPEC §10 remediation inline — name the missing/
 * incompatible skill(s) and offer a Reinstall CTA that routes through
 * `PurchaseService.install(id, true)` — `thenEnable: true` — the exact same
 * install+enable path the marketplace's own ownership button uses.
 *
 * A successful load ALSO surfaces `unresolved` skill ids distinctly — those
 * are skills the template named that resolved fine server-side but that this
 * client's fixed P0 enablement seam can't turn on automatically yet (see
 * `TemplatesService`'s doc comment). That is not a failure, so it does not
 * block the `loaded` event / view switch; it is a quiet inline note.
 */
@Component({
  selector: 'app-templates-gallery',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './templates-gallery.component.html',
  styleUrl: './templates-gallery.component.css',
})
export class TemplatesGalleryComponent implements OnInit {
  readonly templatesSvc = inject(TemplatesService);
  readonly purchase = inject(PurchaseService);

  /** A template loaded successfully — the shell switches back to the Assistant view. */
  readonly loaded = output<void>();

  readonly templates = this.templatesSvc.templates;
  readonly loading = this.templatesSvc.loading;
  readonly isEmpty = this.templatesSvc.isEmpty;

  /** Template id currently mid-load (disables its own Load button only). */
  readonly loadingId = signal<string | null>(null);
  /** Last load outcome per template id — drives the missing-skill / unresolved-skill notes. */
  readonly outcomes = signal<Record<string, TemplateLoadOutcome>>({});

  ngOnInit(): void {
    void this.templatesSvc.refresh();
  }

  /** A skill id's display name when it's one of the known dev-registry manifests, else the raw id. */
  skillLabel(skillId: string): string {
    return manifestFor(skillId)?.name ?? skillId;
  }

  trackTemplate(_index: number, t: TemplateView): string {
    return t.id;
  }

  async onLoad(templateId: string): Promise<void> {
    this.loadingId.set(templateId);
    try {
      const outcome = await this.templatesSvc.load(templateId);
      this.outcomes.update((m) => ({ ...m, [templateId]: outcome }));
      if (outcome.ok) this.loaded.emit();
    } finally {
      this.loadingId.set(null);
    }
  }

  /** Reinstall a missing/incompatible skill named by a failed load, then let the user retry Load. */
  async onReinstall(skillId: string): Promise<void> {
    await this.purchase.install(skillId, /* thenEnable */ true);
  }

  outcomeFor(templateId: string): TemplateLoadOutcome | null {
    return this.outcomes()[templateId] ?? null;
  }
}
