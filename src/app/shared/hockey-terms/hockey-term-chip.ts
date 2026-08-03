import { Component, HostListener, Input, signal } from '@angular/core';

import {
  getHockeyTermDefinition,
  getHockeyTermDisplayLabel,
  HockeyTermKey,
  loadStoredHockeyExperienceLevel,
} from './hockey-terms.data';

let hockeyTermChipInstanceId = 0;

@Component({
  selector: 'app-hockey-term',
  standalone: true,
  templateUrl: './hockey-term-chip.html',
  styleUrl: './hockey-term-chip.css',
})
export class HockeyTermChip {
  @Input({ required: true }) term!: HockeyTermKey;
  @Input() compact = false;
  @Input() popoverAlign: 'start' | 'center' | 'end' = 'start';

  readonly open = signal(false);
  readonly panelId = `hockey-term-panel-${++hockeyTermChipInstanceId}`;
  readonly titleId = `${this.panelId}-title`;

  definition() {
    return getHockeyTermDefinition(this.term);
  }

  experience() {
    return loadStoredHockeyExperienceLevel();
  }

  displayLabel(): string {
    return getHockeyTermDisplayLabel(this.term, this.experience(), this.compact);
  }

  toggle(): void {
    this.open.update((value) => !value);
  }

  close(): void {
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  closeOnEscape(): void {
    this.close();
  }
}
