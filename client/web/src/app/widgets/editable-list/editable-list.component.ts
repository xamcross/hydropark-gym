import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService } from '../../state/session.service';
import { ToolsService } from '../../tools/tools.service';
import { InferenceService } from '../../inference/inference.service';
import { expressInSystem } from '../../tools/unit-math';
import { IngredientItem, UnitId } from '../../ipc/contract';

interface DisplayItem extends IngredientItem {
  displayQty?: number;
  displayUnit?: UnitId;
}

@Component({
  selector: 'app-editable-list',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './editable-list.component.html',
  styleUrl: './editable-list.component.css',
})
export class EditableListComponent {
  nameDraft = signal('');

  readonly items = computed<DisplayItem[]>(() => {
    const system = this.session.unitSystem();
    return this.session.ingredients().map((item) => {
      if (item.qty === undefined || !item.unit) return { ...item };
      const { value, unit } = expressInSystem(item.qty, item.unit, system);
      return { ...item, displayQty: value, displayUnit: unit };
    });
  });

  constructor(private readonly session: SessionService, private readonly tools: ToolsService, inference: InferenceService) {
    inference.onPrefillRequest((widget, args) => {
      if (widget !== 'editable_list') return;
      const a = args as { item?: { name?: string } };
      if (a.item?.name) this.nameDraft.set(a.item.name);
    });
  }

  // --- UI-first triggers (P0-03.6) ----------------------------------------

  addItem(): void {
    const name = this.nameDraft().trim();
    if (!name) return;
    void this.tools.listManage({ op: 'add', item: { name } });
    this.nameDraft.set('');
  }

  remove(id: string): void {
    void this.tools.listManage({ op: 'remove', item: { id } });
  }

  toggleChecked(item: IngredientItem): void {
    void this.tools.listManage({ op: item.checked ? 'uncheck' : 'check', item: { id: item.id } });
  }
}
