import { Component, computed, ElementRef, OnDestroy, signal, viewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatMessage, SessionService } from '../../state/session.service';
import { InferenceService } from '../../inference/inference.service';
import { expressInSystem } from '../../tools/unit-math';
import { UnitId } from '../../ipc/contract';
import { TourService } from '../../tour/tour.service';
import { TourChatBridge } from '../../tour/tour.model';
import { TourAnchorDirective } from '../../tour/tour-anchor.directive';

/** Matches inline quantity tokens like `{{q:150:g}}` — see mock-ipc.service.ts's scripted replies. */
const QTY_TOKEN = /\{\{q:(-?\d+(?:\.\d+)?):([a-z_]+)\}\}/g;

interface RenderPiece {
  text: string;
  isQty: boolean;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, TourAnchorDirective],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnDestroy {
  private readonly scrollAnchor = viewChild<ElementRef<HTMLElement>>('scrollAnchor');
  private readonly tour = inject(TourService);

  draft = signal('');

  readonly messages = computed(() => this.session.messages());
  readonly unitSystem = computed(() => this.session.unitSystem());
  readonly tokPerSec = computed(() => this.session.lastTokPerSec());

  /** Lets the tour's magic beat prefill and send from the real composer (Task 6). */
  private readonly tourBridge: TourChatBridge = {
    prefill: (text: string) => this.draft.set(text),
    send: () => this.send(),
  };

  constructor(private readonly session: SessionService, private readonly inference: InferenceService) {
    this.tour.registerChat(this.tourBridge);
  }

  ngOnDestroy(): void {
    this.tour.unregisterChat(this.tourBridge);
  }

  /** Splits a message's raw text into plain-text / quantity pieces, converting quantities to the current unit system live (exact arithmetic, see unit-math.ts). */
  renderPieces(msg: ChatMessage): RenderPiece[] {
    const pieces: RenderPiece[] = [];
    let lastIndex = 0;
    const system = this.unitSystem();
    for (const match of msg.text.matchAll(QTY_TOKEN)) {
      const [full, valueStr, unitStr] = match;
      const index = match.index ?? 0;
      if (index > lastIndex) pieces.push({ text: msg.text.slice(lastIndex, index), isQty: false });
      const { value, unit } = expressInSystem(Number(valueStr), unitStr as UnitId, system);
      pieces.push({ text: `${trimTrailingZeros(value)} ${unit}`, isQty: true });
      lastIndex = index + full.length;
    }
    if (lastIndex < msg.text.length) pieces.push({ text: msg.text.slice(lastIndex), isQty: false });
    return pieces;
  }

  send(): void {
    const text = this.draft().trim();
    if (!text) return;
    this.draft.set('');
    void this.inference.send(text);
    queueMicrotask(() => this.scrollAnchor()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.send();
    }
  }
}

function trimTrailingZeros(n: number): string {
  return Number(n.toFixed(2)).toString();
}
