import { Component, computed, signal } from '@angular/core';
import { SessionService } from '../../state/session.service';
import { ToolsService } from '../../tools/tools.service';
import { TelemetryService } from '../../state/telemetry.service';
import { IngredientItem, UnitSystem } from '../../ipc/contract';
import { UNIT_DOMAIN, UNIT_SYSTEM, counterpartUnit } from '../../tools/unit-math';

/**
 * US ↔ Metric toggle (P0-03.5). Bound to `convert_units`: flipping it
 * re-expresses every ingredient quantity through the exact-arithmetic tool
 * (one call per unit-bearing item, then a single `list_manage` commit) and
 * the chat transcript picks up the same flip for free — its inline
 * `{{q:…}}` tokens re-render against `unitSystem()` reactively, using the
 * identical arithmetic (see unit-math.ts's file header for why chat uses
 * the pure function directly instead of round-tripping IPC per token).
 */
@Component({
  selector: 'app-segmented-toggle',
  standalone: true,
  templateUrl: './segmented-toggle.component.html',
  styleUrl: './segmented-toggle.component.css',
})
export class SegmentedToggleComponent {
  readonly system = computed(() => this.session.unitSystem());
  readonly busy = signal(false);

  constructor(
    private readonly session: SessionService,
    private readonly tools: ToolsService,
    private readonly telemetry: TelemetryService
  ) {}

  // --- UI-first trigger (P0-03.6): direct tool call, no model round-trip ---
  async flip(target: UnitSystem): Promise<void> {
    const current = this.session.unitSystem();
    if (target === current || this.busy()) return;
    this.busy.set(true);
    try {
      const items = this.session.ingredients();
      const converted: IngredientItem[] = [];
      for (const item of items) {
        if (item.qty !== undefined && item.unit && UNIT_SYSTEM[item.unit] !== target) {
          const domain = UNIT_DOMAIN[item.unit];
          const to_unit = counterpartUnit(item.unit);
          const res = await this.tools.convertUnits({ domain, value: item.qty, from_unit: item.unit, to_unit });
          converted.push({ ...item, qty: res?.value ?? item.qty, unit: res?.unit ?? item.unit });
        } else {
          converted.push(item);
        }
      }
      if (items.length > 0) {
        await this.tools.listManage({ op: 'set_all', items: converted });
      }
      this.session.unitSystem.set(target);
      this.telemetry.unitsFlipped(current, target, 'ui');
    } finally {
      this.busy.set(false);
    }
  }
}
