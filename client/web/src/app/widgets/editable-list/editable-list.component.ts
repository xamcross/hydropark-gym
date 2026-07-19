import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService } from '../../state/session.service';
import { ToolsService } from '../../tools/tools.service';
import { InferenceService } from '../../inference/inference.service';
import { expressInSystem } from '../../tools/unit-math';
import { IngredientItem, UnitId } from '../../ipc/contract';
import { BoundState } from '../widget-contract';

interface DisplayItem extends IngredientItem {
  displayQty?: number;
  displayUnit?: UnitId;
}

/**
 * `editable_list` widget — a worked example of the base widget contract's
 * read-only bound-state rule (P1-06.1 · contract §5).
 *
 * Two mount modes, SELECTED BY THE HOST, additively:
 *  - SELF-SOURCED (the P0 mount, `bound` absent): reads/writes the ingredient
 *    list through `SessionService`/`ToolsService`, exactly as before.
 *  - BOUND (composed-panel-host, `bound` set): renders the LIVE slot value; and
 *    when the owning skill is NOT the slot's writer-of-record, it renders
 *    READ-ONLY — the add form and per-row remove are withdrawn, the check boxes
 *    are `disabled`, and a "Managed by {writer}" note names where edits go.
 *
 * OnPush + signals throughout; the unit-system display conversion is shared
 * across both modes so a bound observer still respects the US/Metric toggle.
 */
@Component({
  selector: 'app-editable-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './editable-list.component.html',
  styleUrl: './editable-list.component.css',
})
export class EditableListComponent {
  /**
   * The read-only-aware slot binding (contract §5). Absent ⇒ the self-sourced P0
   * mount; present ⇒ render the live slot value, read-only when not the writer.
   */
  readonly bound = input<BoundState<IngredientItem[]> | null>(null);

  nameDraft = signal('');

  /** The source list: the bound slot value when bound, else the session ingredients. */
  private readonly sourceItems = computed<IngredientItem[]>(() => {
    const b = this.bound();
    if (b) return (b.value ?? []) as IngredientItem[];
    return this.session.ingredients();
  });

  readonly items = computed<DisplayItem[]>(() => {
    const system = this.session.unitSystem();
    return this.sourceItems().map((item) => {
      if (item.qty === undefined || !item.unit) return { ...item };
      const { value, unit } = expressInSystem(item.qty, item.unit, system);
      return { ...item, displayQty: value, displayUnit: unit };
    });
  });

  /** True when bound to a slot this skill does not own — all edits are disabled (§5). */
  readonly isReadonly = computed<boolean>(() => this.bound()?.readonly ?? false);
  /**
   * The writer-of-record display name to attribute edits to, or null when this
   * widget is the writer (or unbound). Drives the "Managed by …" affordance (§5).
   */
  readonly managedBy = computed<string | null>(() => {
    const b = this.bound();
    return b?.readonly ? b.writer : null;
  });

  constructor(
    private readonly session: SessionService,
    private readonly tools: ToolsService,
    inference: InferenceService
  ) {
    inference.onPrefillRequest((widget, args) => {
      if (widget !== 'editable_list') return;
      if (this.isReadonly()) return; // a read-only observer never absorbs a prefill
      const a = args as { item?: { name?: string } };
      if (a.item?.name) this.nameDraft.set(a.item.name);
    });
  }

  // --- UI-first triggers (P0-03.6) — all no-op when read-only (§5) ---------

  addItem(): void {
    if (this.isReadonly()) return;
    const name = this.nameDraft().trim();
    if (!name) return;
    void this.tools.listManage({ op: 'add', item: { name } });
    this.nameDraft.set('');
  }

  remove(id: string): void {
    if (this.isReadonly()) return;
    void this.tools.listManage({ op: 'remove', item: { id } });
  }

  toggleChecked(item: IngredientItem): void {
    if (this.isReadonly()) return;
    void this.tools.listManage({ op: item.checked ? 'uncheck' : 'check', item: { id: item.id } });
  }
}
