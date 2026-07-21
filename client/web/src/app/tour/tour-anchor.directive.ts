import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from '@angular/core';
import { TourService } from './tour.service';
import { TourAnchorId } from './tour.model';

/**
 * Marks a shell element as a tour target. On init it registers its host element
 * with {@link TourService} under the given id; on destroy it unregisters. This
 * keeps the overlay decoupled from shell markup — anchors travel with the element.
 */
@Directive({ selector: '[tourAnchor]', standalone: true })
export class TourAnchorDirective implements OnInit, OnDestroy {
  @Input({ required: true }) tourAnchor!: TourAnchorId;

  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly tour = inject(TourService);

  ngOnInit(): void {
    this.tour.registerAnchor(this.tourAnchor, this.el);
  }
  ngOnDestroy(): void {
    this.tour.unregisterAnchor(this.tourAnchor, this.el);
  }
}
