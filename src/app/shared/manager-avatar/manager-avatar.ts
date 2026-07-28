import { Component, Input } from '@angular/core';
import { getProfileIcon } from '../profile-icon/profile-icon.data';

@Component({
  selector: 'app-manager-avatar',
  standalone: true,
  template: `
    <span class="manager-avatar" [class]="'manager-avatar manager-avatar-' + size" [title]="label">
      <img
        [src]="icon.assetPath"
        [alt]="label + ' profile picture'"
        width="512"
        height="512"
        loading="lazy"
        decoding="async"
      />
    </span>
  `,
  styles: `
    :host { display: inline-flex; flex: 0 0 auto; vertical-align: middle; }
    .manager-avatar {
      display: inline-flex;
      overflow: visible;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      box-shadow: none;
      image-rendering: pixelated;
    }
    .manager-avatar-xs { width: 24px; height: 24px; }
    .manager-avatar-sm { width: 32px; height: 32px; }
    .manager-avatar-md { width: 42px; height: 42px; }
    .manager-avatar-lg { width: 56px; height: 56px; }
    img { width: 100%; height: 100%; object-fit: contain; display: block; }
  `,
})
export class ManagerAvatar {
  @Input() profileIconId: string | null | undefined;
  @Input() label = 'Manager';
  @Input() size: 'xs' | 'sm' | 'md' | 'lg' = 'sm';

  get icon() {
    return getProfileIcon(this.profileIconId);
  }
}
