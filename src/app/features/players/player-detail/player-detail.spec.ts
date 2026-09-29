import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { PlayerDetail } from './player-detail';

describe('PlayerDetail', () => {
  let component: PlayerDetail;
  let fixture: ComponentFixture<PlayerDetail>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlayerDetail],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ playerId: '101' }),
              queryParamMap: convertToParamMap({}),
            },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlayerDetail);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
