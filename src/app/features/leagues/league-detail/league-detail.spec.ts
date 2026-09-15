import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LeagueDetail } from './league-detail';
import type { League } from '../../../core/league/league.service';
import type { FantasyDraft } from '../../../core/draft/draft.models';

describe('LeagueDetail', () => {
  let component: LeagueDetail;
  let fixture: ComponentFixture<LeagueDetail>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeagueDetail],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(LeagueDetail);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('keeps league size management in a closed disclosure with a compact capacity summary', () => {
    component.loading.set(false);
    component.isCommissioner.set(true);
    component.league.set({
      teamCount: 2,
      joinStatus: 'open',
      maxTeams: 4,
    } as League);
    fixture.detectChanges();

    const disclosure = fixture.nativeElement.querySelector('.league-capacity-disclosure') as HTMLDetailsElement | null;
    const summary = disclosure?.querySelector('summary');

    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    expect(summary?.textContent).toContain('League size');
    expect(summary?.textContent).toContain('2 joined · 4-team limit');
    expect(disclosure?.querySelector('#league-capacity-select')).toBeTruthy();
    expect(disclosure?.querySelector('#league-capacity-password')).toBeTruthy();
  });

  it('offers an explicit capacity reset only for a scheduled Draft more than 24 hours away', () => {
    const now = Date.now();
    component.now.set(now);
    component.isCommissioner.set(true);
    component.league.set({
      teamCount: 2,
      joinStatus: 'locked',
      joinLockedReason: 'draft-order-saved',
      maxTeams: 2,
    } as League);
    component.draft.set({
      status: 'scheduled',
      clockStatus: 'stopped',
      nextOverallPick: 1,
      draftedAssetKeys: [],
      roundOneOrder: ['owner-one', 'owner-two'],
      lastSettingsSubmissionId: 'settings-current-submission',
      scheduledStartAt: new Date(now + 48 * 60 * 60 * 1000),
    } as unknown as FantasyDraft);

    expect(component.preDraftMemberRemovalAvailable()).toBe(false);
    expect(component.scheduledCapacityReopenAvailable()).toBe(true);
    expect(component.capacityChangeAvailable()).toBe(true);

    component.now.set(now + 24 * 60 * 60 * 1000);
    expect(component.scheduledCapacityReopenAvailable()).toBe(false);
    expect(component.capacityAvailabilityMessage()).toContain('frozen within 24 hours');
  });
});
