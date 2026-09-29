import { Component, Input, signal } from '@angular/core';

import { type AssetPortraitSource, resolveAssetPortrait } from './asset-portrait.util';

@Component({
  selector: 'app-asset-portrait',
  templateUrl: './asset-portrait.html',
  styleUrl: './asset-portrait.css',
})
export class AssetPortrait {
  @Input({ required: true }) asset!: AssetPortraitSource;

  private readonly failedImageUrls = signal<ReadonlySet<string>>(new Set<string>());

  get portrait() {
    return resolveAssetPortrait(this.asset, this.failedImageUrls());
  }

  markImageUnavailable(imageUrl: string): void {
    this.failedImageUrls.update((failedUrls) => {
      if (failedUrls.has(imageUrl)) {
        return failedUrls;
      }

      const nextFailedUrls = new Set(failedUrls);
      nextFailedUrls.add(imageUrl);
      return nextFailedUrls;
    });
  }
}
