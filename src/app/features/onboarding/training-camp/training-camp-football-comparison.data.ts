export interface TrainingCampFootballComparison {
  hockeyRole: string;
  hockeyPositions: readonly string[];
  footballRole: string;
  footballBadge: 'WR' | 'RB' | 'QB';
  headline: string;
  summary: string;
  scoringDrivers: string;
  draftLesson: string;
  cssClass: 'wings' | 'centers' | 'defense' | 'goalies';
}

/**
 * A beginner-facing mental model, not a claim that the sports score the same.
 *
 * Projection V11 intentionally gives LW and RW the same position priors. Center
 * uses the same forward scoring rules, but its prior leans slightly more toward
 * assists, power-play involvement, short-handed involvement, and ice time. That
 * supports one honest split: wings resemble big-play wide receivers while centers
 * resemble target-heavy possession/slot receivers. Individual player role still
 * matters more than the label.
 */
export const TRAINING_CAMP_FOOTBALL_COMPARISONS: readonly TrainingCampFootballComparison[] = [
  {
    hockeyRole: 'Wings',
    hockeyPositions: ['LW', 'RW'],
    footballRole: 'Big-play wide receivers',
    footballBadge: 'WR',
    headline: 'Fewer chances, bigger scoring swings',
    summary:
      'Think of a wide receiver who gets fewer passes—only a few chances—but can turn one long catch or touchdown into a strong fantasy week. Wings can feel similar: a goal or assist can create a huge six-game burst, while missed chances can make the next matchup much quieter.',
    scoringDrivers: 'Goals · shots · assists · hits',
    draftLesson: 'Draft for upside: one matchup can be huge and the next can be much quieter.',
    cssClass: 'wings',
  },
  {
    hockeyRole: 'Centers',
    hockeyPositions: ['C'],
    footballRole: 'Target-heavy slot receivers',
    footballBadge: 'WR',
    headline: 'Forward upside with more ways to stay involved',
    summary:
      'Centers use the same forward scoring, but the projection model expects slightly more playmaking, special-teams involvement, and ice time on average.',
    scoringDrivers: 'Assists · shots · power-play work · ice time',
    draftLesson: 'Still explosive, often with a slightly steadier involvement floor.',
    cssClass: 'centers',
  },
  {
    hockeyRole: 'Defensemen',
    hockeyPositions: ['D'],
    footballRole: 'Workhorse running backs',
    footballBadge: 'RB',
    headline: 'Reliable volume builds a dependable floor',
    summary:
      'Heavy minutes create repeated chances to score through shots, hits, and blocks even when the defenseman does not record a goal or assist.',
    scoringDrivers: 'Ice time · blocks · hits · shots',
    draftLesson: 'Steady workload can be more valuable than one flashy game.',
    cssClass: 'defense',
  },
  {
    hockeyRole: 'Team Goalie Unit',
    hockeyPositions: ['G'],
    footballRole: 'Quarterbacks',
    footballBadge: 'QB',
    headline: 'One premium slot with high raw point totals',
    summary:
      'Most viable goalie units contribute useful points. Save volume, save quality, wins, and shutouts can turn the position into a matchup-changing scorer.',
    scoringDrivers: 'Saves · save percentage · wins · shutouts',
    draftLesson: 'Compare goalie units with goalie units, not raw points with skaters.',
    cssClass: 'goalies',
  },
] as const;
