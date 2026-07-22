import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { getScoringRuntimeState } from '../../core/cycle/cycle-runtime.config';
import { Navbar } from '../../shared/navbar/navbar';
import { buildFullPixelMarquee, PixelLogoItem } from '../../shared/pixel-theme/pixel-theme.data';

@Component({
  selector: 'app-main-layout',
  imports: [RouterOutlet, Navbar],
  templateUrl: './main-layout.html',
  styleUrl: './main-layout.css',
})
export class MainLayout {
  readonly scoringRuntime = getScoringRuntimeState();
  readonly teamRibbon: PixelLogoItem[] = buildFullPixelMarquee();
}
