import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  COMMISSIONER_DRAFT_NIGHT_CHECKLIST,
  COMMISSIONER_RECOVERY_STEPS,
} from '../../../core/league/commissioner-playbook.util';

@Component({
  selector: 'app-commissioner-guide',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './commissioner-guide.html',
  styleUrl: './commissioner-guide.css',
})
export class CommissionerGuide {
  readonly draftNightChecklist = COMMISSIONER_DRAFT_NIGHT_CHECKLIST;
  readonly recoverySteps = COMMISSIONER_RECOVERY_STEPS;
}
