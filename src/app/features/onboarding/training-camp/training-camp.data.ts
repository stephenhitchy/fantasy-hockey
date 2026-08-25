export type TrainingCampStepId = 'cycles' | 'roster' | 'moves' | 'cards' | 'season';

export interface TrainingCampDrill {
  id: string;
  label: string;
  title: string;
  body: string;
  coachNote: string;
  whyItMatters?: string;
}

export interface TrainingCampStep {
  id: TrainingCampStepId;
  number: string;
  eyebrow: string;
  shortLabel: string;
  title: string;
  drills: readonly TrainingCampDrill[];
}

export const TRAINING_CAMP_STEPS: readonly TrainingCampStep[] = [
  {
    id: 'cycles',
    number: '1',
    eyebrow: 'Fair Matchups',
    shortLabel: 'Six Games',
    title: 'Six games for every active spot',
    drills: [
      {
        id: 'six-game-counter',
        label: 'Drill 1',
        title: 'One active spot. Six NHL games.',
        body:
          'Each active roster spot gets six NHL games. Those six games make that spot’s score for the matchup.',
        coachNote:
          'Your lineup is 14 separate six-game races. One spot can finish before another.',
        whyItMatters:
          'NHL teams play uneven schedules. Equal six-game opportunities reduce schedule luck, keep both managers’ chances more even, and let you focus on meaningful roster strategy instead of changing a lineup every day. Games and points already earned stay protected.',
      },
      {
        id: 'game-seven',
        label: 'Drill 2',
        title: 'Game 7 starts the next matchup',
        body:
          'After a spot counts six games, its next NHL game starts that spot’s next matchup. Other spots keep finishing their own six.',
        coachNote:
          'It is okay if one spot finishes before another. Every spot still counts exactly six games.',
      },
    ],
  },
  {
    id: 'roster',
    number: '2',
    eyebrow: 'Build Your Club',
    shortLabel: 'Your Roster',
    title: 'Build a balanced roster',
    drills: [
      {
        id: 'lineup-spots',
        label: 'Drill 1',
        title: 'Start 14 scoring spots',
        body:
          'Your active lineup has 3 left wings, 3 centers, 3 right wings, 4 defensemen, and 1 team goalie unit. You also get 3 bench spots and 3 injured-reserve spots.',
        coachNote:
          'Only active lineup spots earn points. Bench and injured-reserve spots protect your depth.',
      },
      {
        id: 'position-jobs',
        label: 'Drill 2',
        title: 'Positions have different jobs',
        body:
          'Forwards bring big upside, defensemen add steadier volume, and the team goalie unit usually produces the largest raw total.',
        coachNote: 'Compare a player mostly with other options at the same position.',
      },
    ],
  },
  {
    id: 'moves',
    number: '3',
    eyebrow: 'Line Changes',
    shortLabel: 'Roster Moves',
    title: 'Make moves without erasing games',
    drills: [
      {
        id: 'move-now',
        label: 'Drill 1',
        title: 'Before a spot starts, a move can happen now',
        body:
          'When the affected roster spots have not started their current six-game counters, RinkRat can make the change immediately.',
        coachNote: 'The confirmation screen will clearly say Immediate when the move can happen now.',
      },
      {
        id: 'move-later',
        label: 'Drill 2',
        title: 'After a spot starts, the move waits safely',
        body:
          'Once an affected spot has played, RinkRat schedules the change for its next safe lineup boundary. Games already counted stay protected.',
        coachNote: 'You can submit the move now. RinkRat handles the correct start time for you.',
      },
    ],
  },
  {
    id: 'cards',
    number: '4',
    eyebrow: 'Scouting Report',
    shortLabel: 'Player Cards',
    title: 'Read a player card quickly',
    drills: [
      {
        id: 'card-basics',
        label: 'Drill 1',
        title: 'Start with the Next 6 projection',
        body:
          'The Next 6 number estimates the player’s upcoming six-game score. Season production, recent form, reliability, and availability add context.',
        coachNote: 'Use the projection as a guide, then check why the number looks strong or weak.',
      },
      {
        id: 'game-markers',
        label: 'Drill 2',
        title: 'The game dots show what happened',
        body:
          'Green means the game counted, yellow means an expected game is coming, and red means a scheduled game was missed.',
        coachNote: 'Open the scoring breakdown only when you want the details behind the total.',
      },
    ],
  },
  {
    id: 'season',
    number: '5',
    eyebrow: 'Road to the Cup',
    shortLabel: 'Season Flow',
    title: 'Manage your team while RinkRat runs the season',
    drills: [
      {
        id: 'season-path',
        label: 'Drill 1',
        title: 'Matchups feed the standings and playoffs',
        body:
          'When six-game scores finish, RinkRat updates matchup results and standings. The best records move into the playoff bracket.',
        coachNote: 'Already-played NHL games stay banked while a playoff opponent is being decided.',
      },
      {
        id: 'automatic-season',
        label: 'Final Drill',
        title: 'You manage. RinkRat advances the clock.',
        body:
          'Draft clocks, matchup scoring, standings, and playoff routing run automatically. Your job is to draft, set priorities, and improve your roster.',
        coachNote: 'There is no manual advance button required for normal league play.',
      },
    ],
  },
] as const;

export const TRAINING_CAMP_TOTAL_DRILLS = TRAINING_CAMP_STEPS.reduce(
  (total, step) => total + step.drills.length,
  0,
);
