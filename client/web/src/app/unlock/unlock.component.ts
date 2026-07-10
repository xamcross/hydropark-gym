import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RedeemResult, UnlockService } from './unlock.service';

/**
 * "Enter unlock code" surface for the paid Cooking Assistant (P0-05.5).
 *
 *   >> THROWAWAY VALIDATION PROTOTYPE. NOT production licensing. <<
 *
 * The in-app half of the cold-buyer fulfillment loop (PHASE0-PLAN §4c): the buyer
 * pastes the code from their email, it is HMAC-verified (`unlock-code.ts`), and on
 * success the skill is unlocked + persisted via `UnlockService`. This component
 * owns only the entry/feedback UI; enabling the skill and its panel transform are
 * the skill-toggle's job, which reads the same `UnlockService` seam.
 */
@Component({
  selector: 'app-unlock',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './unlock.component.html',
  styleUrl: './unlock.component.css',
})
export class UnlockComponent {
  readonly code = signal('');
  readonly busy = signal(false);
  readonly result = signal<RedeemResult | null>(null);

  readonly unlocked = computed(() => this.unlock.cookingAssistantUnlocked());
  readonly errorMessage = computed(() => {
    const r = this.result();
    return r && !r.ok ? r.message : null;
  });
  readonly justUnlocked = computed(() => {
    const r = this.result();
    return !!r && r.ok;
  });

  constructor(private readonly unlock: UnlockService) {}

  async redeem(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.result.set(null);
    try {
      const r = await this.unlock.redeem(this.code());
      this.result.set(r);
      if (r.ok) this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
