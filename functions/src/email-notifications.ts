import { createHash } from 'node:crypto';

import { getAuth } from 'firebase-admin/auth';
import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const PASSWORD_RESET_COOLDOWN_SECONDS = 120;
const VERIFICATION_COOLDOWN_SECONDS = 120;
const TEST_INJURY_EMAIL_COOLDOWN_SECONDS = 60;
const INJURY_BATCH_DELAY_MILLISECONDS = 15 * 60 * 1000;
const INJURY_MAX_BATCH_HOLD_MILLISECONDS = 30 * 60 * 1000;
const INJURY_QUEUE_RECHECK_MILLISECONDS = 5 * 60 * 1000;
const INJURY_QUEUE_PROCESS_LIMIT = 250;
const INJURY_WINDOW_LOOKBACK_LIMIT = 8;

const ACTION_REQUIRED_STATUSES = new Set([
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
]);

interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: string;
  idempotencyKey?: string;
}

class TransactionalEmailDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`Email provider rejected the request with status ${status}.`);
    this.name = 'TransactionalEmailDeliveryError';
  }
}

interface ActiveRosterPlayer {
  playerId: number;
  playerName: string;
  position: string;
  nhlTeamAbbreviation: string;
  rosterSlotId: string;
  pendingMoveQueued: boolean;
}

interface InjuryWindowContext {
  cycleNumber: number;
  status: string;
  scheduledGames: number;
  gamesPlayed: number;
  gamesLeft: number;
  isLive: boolean;
  liveGameIds: number[];
}

interface InjuryQueueRecord {
  id: string;
  ownerId: string;
  leagueId: string;
  leagueName: string;
  teamName: string;
  eventId: string;
  playerId: number;
  playerName: string;
  position: string;
  nhlTeamAbbreviation: string;
  rosterSlotId: string;
  injuryStatus: string;
  note: string;
  irEligible: boolean;
  waitForGameFinal: boolean;
  detectedAtMillis: number;
  readyAfterMillis: number;
  gameFinalObservedAtMillis: number;
}

interface ReadyInjuryAlert {
  queue: InjuryQueueRecord;
  window: InjuryWindowContext;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeEmail(value: unknown): string {
  return asString(value).toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length >= 3 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAppBaseUrl(): string {
  const configured = asString(process.env['APP_BASE_URL']);
  return (configured || 'https://rinkratfantasy.com').replace(/\/+$/, '');
}

function getFromAddress(): string {
  const configured = asString(process.env['EMAIL_FROM_ADDRESS']);

  if (!configured || !isValidEmail(configured)) {
    throw new Error(
      'EMAIL_FROM_ADDRESS is missing or invalid. Add it to functions/.env.nhl-fantasy-app-ab673 before deploying.',
    );
  }

  return configured;
}

function getFromName(): string {
  return asString(process.env['EMAIL_FROM_NAME']) || 'RinkRat Fantasy';
}

function getReplyToAddress(): string | null {
  const configured = asString(process.env['EMAIL_REPLY_TO']);
  return isValidEmail(configured) ? configured : null;
}

function buildEmailShell(options: {
  eyebrow: string;
  heading: string;
  intro: string;
  bodyHtml: string;
  buttonLabel?: string;
  buttonUrl?: string;
  footer: string;
}): string {
  const button = options.buttonLabel && options.buttonUrl
    ? `
      <p style="margin:28px 0 10px;text-align:center;">
        <a href="${escapeHtml(options.buttonUrl)}" style="display:inline-block;padding:14px 20px;border:2px solid #9ed8ff;background:#24558a;color:#ffffff;text-decoration:none;font-weight:800;letter-spacing:.02em;">${escapeHtml(options.buttonLabel)}</a>
      </p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0d1723;color:#f7f9fc;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0d1723;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border:2px solid #2a394a;background:#182536;">
            <tr>
              <td style="height:6px;background:#2d6fb5;"></td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <p style="margin:0 0 8px;color:#9ed8ff;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;">${escapeHtml(options.eyebrow)}</p>
                <h1 style="margin:0;color:#ffffff;font-size:30px;line-height:1.1;">${escapeHtml(options.heading)}</h1>
                <p style="margin:18px 0 0;color:#c5d2df;font-size:16px;line-height:1.6;">${escapeHtml(options.intro)}</p>
                <div style="margin-top:22px;color:#e8eef5;font-size:15px;line-height:1.65;">${options.bodyHtml}</div>
                ${button}
                <p style="margin:28px 0 0;padding-top:18px;border-top:1px solid #34465a;color:#8fa2b5;font-size:12px;line-height:1.55;">${escapeHtml(options.footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendTransactionalEmail(email: TransactionalEmail): Promise<void> {
  const apiKey = asString(RESEND_API_KEY.value());

  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY is unavailable to this function. Confirm the secret exists and redeploy the function so it is bound to the current secret version.',
    );
  }

  const replyTo = getReplyToAddress();
  const from = `${getFromName()} <${getFromAddress()}>`;
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(email.idempotencyKey
        ? { 'Idempotency-Key': email.idempotencyKey.slice(0, 256) }
        : {}),
    },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      tags: [
        {
          name: 'category',
          value: email.category.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 256),
        },
      ],
    }),
  });

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 1000);
    throw new TransactionalEmailDeliveryError(response.status, responseText);
  }
}

function buildActionCodeSettings() {
  const appBaseUrl = getAppBaseUrl();
  const appHostname = new URL(appBaseUrl).hostname;

  return {
    url: `${appBaseUrl}/`,
    handleCodeInApp: false,
    linkDomain: appHostname,
  };
}

async function claimRateLimit(
  key: string,
  cooldownSeconds: number,
): Promise<boolean> {
  const reference = db.doc(`systemEmailRateLimits/${key}`);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const lastRequestedAt = snapshot.data()?.['lastRequestedAt'];
    const lastRequestedMillis = lastRequestedAt instanceof Timestamp
      ? lastRequestedAt.toMillis()
      : 0;
    const now = Date.now();

    if (lastRequestedMillis > 0 && now - lastRequestedMillis < cooldownSeconds * 1000) {
      return false;
    }

    transaction.set(
      reference,
      {
        lastRequestedAt: Timestamp.fromMillis(now),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return true;
  });
}

async function releaseRateLimit(key: string): Promise<void> {
  await db.doc(`systemEmailRateLimits/${key}`).delete();
}

async function sendVerificationEmail(
  userId: string,
  email: string,
  username: string,
  category: 'welcome-verification' | 'verification-resend',
): Promise<void> {
  const verificationLink = await getAuth().generateEmailVerificationLink(
    email,
    buildActionCodeSettings(),
  );
  const safeName = username || 'Manager';
  const isWelcome = category === 'welcome-verification';
  const subject = isWelcome
    ? 'Welcome to RinkRat Fantasy — verify your email'
    : 'Verify your RinkRat Fantasy email';

  const text = [
    `Hi ${safeName},`,
    '',
    isWelcome
      ? 'Your RinkRat Fantasy account was created successfully.'
      : 'Use the link below to verify your RinkRat Fantasy email address.',
    '',
    verificationLink,
    '',
    'After verification, you can enable optional injury email alerts from Account Settings.',
    '',
    'You received this transactional email because this address was used for a RinkRat Fantasy account.',
  ].join('\n');

  const html = buildEmailShell({
    eyebrow: isWelcome ? 'Account Created' : 'Email Verification',
    heading: isWelcome ? `Welcome, ${safeName}` : 'Verify your email',
    intro: isWelcome
      ? 'Your RinkRat Fantasy account was created successfully.'
      : 'Confirm that this email address belongs to you.',
    bodyHtml: `
      <p style="margin:0;">Verifying your address helps protect your account and unlocks optional injury alert emails.</p>
      <p style="margin:14px 0 0;color:#aebfce;">If you did not create this account, you can safely ignore this message.</p>`,
    buttonLabel: 'Verify Email',
    buttonUrl: verificationLink,
    footer: 'This is a transactional account message from RinkRat Fantasy. Injury alerts remain disabled until you enable them in Account Settings.',
  });

  await sendTransactionalEmail({
    to: email,
    subject,
    text,
    html,
    category,
  });

  await db.doc(`users/${userId}`).set(
    {
      lastVerificationEmailSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function getTimestampMillis(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getFiniteNumber(value: unknown, fallback = 0): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function getNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => getFiniteNumber(entry, Number.NaN))
    .filter((entry) => Number.isFinite(entry));
}

function getActiveRosterPlayer(
  rosterData: DocumentData | undefined,
  playerId: number,
): ActiveRosterPlayer | null {
  const activeSlots = Array.isArray(rosterData?.['activeSlots'])
    ? rosterData?.['activeSlots'] as unknown[]
    : [];

  for (const rawSlot of activeSlots) {
    const slot = asRecord(rawSlot);
    const asset = asRecord(slot['asset']);

    if (asset['assetType'] !== 'skater') {
      continue;
    }

    const player = asRecord(asset['player']);
    const rosterPlayerId = typeof player['id'] === 'number'
      ? player['id']
      : Number(player['id']);

    if (rosterPlayerId !== playerId) {
      continue;
    }

    return {
      playerId,
      playerName: asString(player['fullName']) || `Player ${playerId}`,
      position: asString(player['position']),
      nhlTeamAbbreviation: asString(player['nhlTeamAbbreviation']),
      rosterSlotId: asString(slot['slotId']),
      pendingMoveQueued: Object.keys(asRecord(slot['pendingMove'])).length > 0,
    };
  }

  return null;
}

function isActionRequiredStatus(value: unknown): boolean {
  return ACTION_REQUIRED_STATUSES.has(asString(value));
}

function getAvailabilityLabel(status: string): string {
  switch (status) {
    case 'injured-reserve':
      return 'Injured Reserve';
    case 'long-term-injured-reserve':
      return 'Long-Term Injured Reserve';
    case 'personal-leave':
      return 'Personal Leave';
    case 'suspended':
      return 'Suspended';
    case 'out':
      return 'Out';
    default:
      return status || 'Unavailable';
  }
}

function getWindowPlayerId(windowData: Record<string, unknown>): number {
  const asset = asRecord(windowData['asset']);

  if (asset['assetType'] !== 'skater') {
    return 0;
  }

  const player = asRecord(asset['player']);
  return getFiniteNumber(player['id']);
}

async function getOwnerWindowContext(options: {
  leagueId: string;
  ownerId: string;
  playerId: number;
  rosterSlotId: string;
}): Promise<InjuryWindowContext | null> {
  const cyclesCollection = db.collection(`leagues/${options.leagueId}/cycles`);
  let cyclesSnapshot;

  try {
    cyclesSnapshot = await cyclesCollection
      .orderBy('cycleNumber', 'desc')
      .limit(INJURY_WINDOW_LOOKBACK_LIMIT)
      .get();
  } catch {
    cyclesSnapshot = await cyclesCollection.get();
  }

  const cycleDocuments = [...cyclesSnapshot.docs]
    .sort((first, second) => {
      const firstCycle = getFiniteNumber(first.data()['cycleNumber']);
      const secondCycle = getFiniteNumber(second.data()['cycleNumber']);
      return secondCycle - firstCycle;
    })
    .slice(0, INJURY_WINDOW_LOOKBACK_LIMIT);

  const teamWindowSnapshots = await Promise.all(
    cycleDocuments.map((cycleDocument) =>
      db.doc(`${cycleDocument.ref.path}/teamWindows/${options.ownerId}`).get(),
    ),
  );
  const candidates: InjuryWindowContext[] = [];

  for (const [index, teamWindowSnapshot] of teamWindowSnapshots.entries()) {
    if (!teamWindowSnapshot.exists) {
      continue;
    }

    const cycleNumber = getFiniteNumber(
      cycleDocuments[index]?.data()['cycleNumber'],
    );
    const rawWindows = Array.isArray(teamWindowSnapshot.data()?.['windows'])
      ? teamWindowSnapshot.data()?.['windows'] as unknown[]
      : [];

    for (const rawWindow of rawWindows) {
      const windowData = asRecord(rawWindow);

      if (
        asString(windowData['rosterSlotId']) !== options.rosterSlotId ||
        getWindowPlayerId(windowData) !== options.playerId
      ) {
        continue;
      }

      const scheduledGames = Math.max(0, getFiniteNumber(windowData['scheduledGames']));
      const gamesPlayed = Math.max(0, getFiniteNumber(windowData['gamesPlayed']));
      const storedGamesLeft = getFiniteNumber(windowData['gamesLeft'], Number.NaN);
      const gamesLeft = Number.isFinite(storedGamesLeft)
        ? Math.max(0, storedGamesLeft)
        : Math.max(0, scheduledGames - gamesPlayed);
      const liveGameIds = getNumberArray(windowData['liveGameIds']);
      const gameStates = asRecord(windowData['gameStates']);
      const isLive = liveGameIds.length > 0 ||
        Object.values(gameStates).some((state) => state === 'live');

      candidates.push({
        cycleNumber: getFiniteNumber(windowData['cycleNumber'], cycleNumber),
        status: asString(windowData['status']) || 'scheduled',
        scheduledGames,
        gamesPlayed,
        gamesLeft,
        isLive,
        liveGameIds,
      });
    }
  }

  const playoffBankSnapshots = await db.collection(
    `leagues/${options.leagueId}/playoffWindowBanks/${options.ownerId}/windows`,
  ).get();

  for (const bankSnapshot of playoffBankSnapshots.docs) {
    const bankData = bankSnapshot.data();
    const bankCycleNumber = getFiniteNumber(
      bankData['sourceCycleNumber'],
      getFiniteNumber(bankData['windowNumber']),
    );
    const rawSlotWindows = Array.isArray(bankData['slotWindows'])
      ? bankData['slotWindows'] as unknown[]
      : [];

    for (const rawWindow of rawSlotWindows) {
      const windowData = asRecord(rawWindow);

      if (
        asString(windowData['rosterSlotId']) !== options.rosterSlotId ||
        getWindowPlayerId(windowData) !== options.playerId
      ) {
        continue;
      }

      const scheduledGames = Math.max(0, getFiniteNumber(windowData['scheduledGames']));
      const gamesPlayed = Math.max(0, getFiniteNumber(windowData['gamesPlayed']));
      const storedGamesLeft = getFiniteNumber(windowData['gamesLeft'], Number.NaN);
      const gamesLeft = Number.isFinite(storedGamesLeft)
        ? Math.max(0, storedGamesLeft)
        : Math.max(0, scheduledGames - gamesPlayed);
      const liveGameIds = getNumberArray(windowData['liveGameIds']);
      const gameStates = asRecord(windowData['gameStates']);
      const isLive = liveGameIds.length > 0 ||
        Object.values(gameStates).some((state) => state === 'live');

      candidates.push({
        cycleNumber: getFiniteNumber(windowData['cycleNumber'], bankCycleNumber),
        status: asString(windowData['status']) || asString(bankData['status']) || 'scheduled',
        scheduledGames,
        gamesPlayed,
        gamesLeft,
        isLive,
        liveGameIds,
      });
    }
  }

  candidates.sort((first, second) => second.cycleNumber - first.cycleNumber);

  return candidates.find((candidate) =>
    candidate.status !== 'complete' && candidate.gamesLeft > 0,
  ) ?? candidates[0] ?? null;
}

async function writeInjuryNotificationLog(
  notificationKey: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.doc(`emailNotificationLog/${notificationKey}`).set(
    {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function queueInjuryAlertForOwner(options: {
  eventId: string;
  leagueId: string;
  leagueName: string;
  ownerId: string;
  teamName: string;
  player: ActiveRosterPlayer;
  status: string;
  note: string;
  irEligible: boolean;
}): Promise<void> {
  const notificationKey = createHash('sha256')
    .update(`${options.eventId}:${options.leagueId}:${options.ownerId}:${options.player.playerId}`)
    .digest('hex');
  const queueRef = db.doc(`injuryEmailQueue/${notificationKey}`);
  const existing = await queueRef.get();

  if (existing.exists) {
    return;
  }

  const profileSnapshot = await db.doc(`users/${options.ownerId}`).get();
  let authUser;

  try {
    authUser = await getAuth().getUser(options.ownerId);
  } catch (error: unknown) {
    const code = asString(asRecord(error)['code']);

    if (code === 'auth/user-not-found') {
      await writeInjuryNotificationLog(notificationKey, {
        status: 'skipped-user-missing',
        ownerId: options.ownerId,
        leagueId: options.leagueId,
        playerId: options.player.playerId,
        eventId: options.eventId,
      });
      return;
    }

    throw error;
  }

  const profile = profileSnapshot.data() ?? {};

  if (profile['injuryEmailEnabled'] !== true) {
    await writeInjuryNotificationLog(notificationKey, {
      status: 'skipped-disabled',
      ownerId: options.ownerId,
      leagueId: options.leagueId,
      playerId: options.player.playerId,
      eventId: options.eventId,
    });
    return;
  }

  if (!authUser.email || !authUser.emailVerified) {
    await writeInjuryNotificationLog(notificationKey, {
      status: 'skipped-unverified',
      ownerId: options.ownerId,
      leagueId: options.leagueId,
      playerId: options.player.playerId,
      eventId: options.eventId,
    });
    return;
  }

  if (options.player.pendingMoveQueued) {
    await writeInjuryNotificationLog(notificationKey, {
      status: 'skipped-move-already-queued',
      ownerId: options.ownerId,
      leagueId: options.leagueId,
      playerId: options.player.playerId,
      eventId: options.eventId,
    });
    return;
  }

  const window = await getOwnerWindowContext({
    leagueId: options.leagueId,
    ownerId: options.ownerId,
    playerId: options.player.playerId,
    rosterSlotId: options.player.rosterSlotId,
  });

  if (!window || window.status === 'complete' || window.gamesLeft <= 0) {
    await writeInjuryNotificationLog(notificationKey, {
      status: 'skipped-no-actionable-window',
      ownerId: options.ownerId,
      leagueId: options.leagueId,
      playerId: options.player.playerId,
      eventId: options.eventId,
    });
    return;
  }

  const now = Date.now();
  const queueData = {
    status: 'pending',
    eventId: options.eventId,
    ownerId: options.ownerId,
    leagueId: options.leagueId,
    leagueName: options.leagueName,
    teamName: options.teamName,
    playerId: options.player.playerId,
    playerName: options.player.playerName,
    position: options.player.position,
    nhlTeamAbbreviation: options.player.nhlTeamAbbreviation,
    rosterSlotId: options.player.rosterSlotId,
    injuryStatus: options.status,
    note: options.note,
    irEligible: options.irEligible,
    waitForGameFinal: window.isLive,
    initialCycleNumber: window.cycleNumber,
    initialGamesPlayed: window.gamesPlayed,
    initialGamesLeft: window.gamesLeft,
    initialLiveGameIds: window.liveGameIds,
    detectedAt: Timestamp.fromMillis(now),
    readyAfter: Timestamp.fromMillis(now + INJURY_BATCH_DELAY_MILLISECONDS),
    gameFinalObservedAt: null,
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await queueRef.set(queueData);
  await writeInjuryNotificationLog(notificationKey, {
    status: 'queued',
    ownerId: options.ownerId,
    leagueId: options.leagueId,
    playerId: options.player.playerId,
    eventId: options.eventId,
    waitForGameFinal: window.isLive,
  });
}

function normalizeInjuryQueueRecord(
  id: string,
  data: DocumentData,
): InjuryQueueRecord | null {
  const ownerId = asString(data['ownerId']);
  const leagueId = asString(data['leagueId']);
  const playerId = getFiniteNumber(data['playerId']);

  if (!ownerId || !leagueId || playerId <= 0) {
    return null;
  }

  return {
    id,
    ownerId,
    leagueId,
    leagueName: asString(data['leagueName']) || 'Fantasy Hockey League',
    teamName: asString(data['teamName']) || 'Your Fantasy Team',
    eventId: asString(data['eventId']),
    playerId,
    playerName: asString(data['playerName']) || `Player ${playerId}`,
    position: asString(data['position']),
    nhlTeamAbbreviation: asString(data['nhlTeamAbbreviation']),
    rosterSlotId: asString(data['rosterSlotId']),
    injuryStatus: asString(data['injuryStatus']),
    note: asString(data['note']),
    irEligible: data['irEligible'] === true,
    waitForGameFinal: data['waitForGameFinal'] === true,
    detectedAtMillis: getTimestampMillis(data['detectedAt']),
    readyAfterMillis: getTimestampMillis(data['readyAfter']),
    gameFinalObservedAtMillis: getTimestampMillis(data['gameFinalObservedAt']),
  };
}

async function updateQueueRecord(
  queueId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.doc(`injuryEmailQueue/${queueId}`).set(
    {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function suppressQueueRecord(
  queue: InjuryQueueRecord,
  reason: string,
): Promise<void> {
  await Promise.all([
    updateQueueRecord(queue.id, {
      status: 'suppressed',
      suppressedReason: reason,
      suppressedAt: FieldValue.serverTimestamp(),
    }),
    writeInjuryNotificationLog(queue.id, {
      status: `suppressed-${reason}`,
      ownerId: queue.ownerId,
      leagueId: queue.leagueId,
      playerId: queue.playerId,
      eventId: queue.eventId,
    }),
  ]);
}

function buildInjuryBatchEmail(
  alerts: ReadyInjuryAlert[],
): Omit<TransactionalEmail, 'to'> {
  const playerGroups = new Map<number, {
    playerName: string;
    position: string;
    nhlTeamAbbreviation: string;
    status: string;
    note: string;
    irEligible: boolean;
    alerts: ReadyInjuryAlert[];
  }>();

  for (const alert of alerts) {
    const existing = playerGroups.get(alert.queue.playerId);

    if (existing) {
      existing.alerts.push(alert);
      continue;
    }

    playerGroups.set(alert.queue.playerId, {
      playerName: alert.queue.playerName,
      position: alert.queue.position,
      nhlTeamAbbreviation: alert.queue.nhlTeamAbbreviation,
      status: alert.queue.injuryStatus,
      note: alert.queue.note,
      irEligible: alert.queue.irEligible,
      alerts: [alert],
    });
  }

  const groups = [...playerGroups.values()];
  const accountUrl = `${getAppBaseUrl()}/account/settings`;
  const subject = groups.length === 1
    ? `${groups[0]?.playerName ?? 'A roster player'} may need a substitution`
    : `${groups.length} roster players may need attention`;
  const textLines = [
    groups.length === 1
      ? 'One active roster player may need attention.'
      : `${groups.length} active roster players may need attention.`,
    '',
  ];
  const htmlSections: string[] = [];

  for (const group of groups) {
    const statusLabel = getAvailabilityLabel(group.status);
    const details = [group.position, group.nhlTeamAbbreviation]
      .filter(Boolean)
      .join(' · ');
    const uniqueLeagueAlerts = [...new Map(
      group.alerts.map((alert) => [alert.queue.leagueId, alert] as const),
    ).values()];

    textLines.push(`${group.playerName}${details ? ` (${details})` : ''} — ${statusLabel}`);

    if (group.note) {
      textLines.push(`Details: ${group.note}`);
    }

    const leagueRows: string[] = [];

    for (const alert of uniqueLeagueAlerts) {
      const reviewUrl = `${getAppBaseUrl()}/leagues/${encodeURIComponent(alert.queue.leagueId)}/team`;
      const gamesLabel = `${alert.window.gamesLeft} game${alert.window.gamesLeft === 1 ? '' : 's'} remaining`;
      textLines.push(
        `• ${alert.queue.leagueName} — ${alert.queue.teamName} — Cycle ${alert.window.cycleNumber}, ${gamesLabel}`,
        `  ${reviewUrl}`,
      );
      leagueRows.push(`
        <tr>
          <td style="padding:10px;border-top:1px solid #34465a;color:#ffffff;font-weight:700;">${escapeHtml(alert.queue.leagueName)}</td>
          <td style="padding:10px;border-top:1px solid #34465a;color:#c5d2df;">${escapeHtml(alert.queue.teamName)}</td>
          <td style="padding:10px;border-top:1px solid #34465a;color:#c5d2df;">Cycle ${alert.window.cycleNumber} · ${alert.window.gamesLeft} remaining</td>
          <td style="padding:10px;border-top:1px solid #34465a;"><a href="${escapeHtml(reviewUrl)}" style="color:#9ed8ff;font-weight:700;">Review</a></td>
        </tr>`);
    }

    textLines.push('');
    htmlSections.push(`
      <section style="margin:0 0 22px;border:1px solid #3a4c60;background:#121d2a;">
        <div style="padding:14px 16px;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">${escapeHtml(group.playerName)} — ${escapeHtml(statusLabel)}</h2>
          <p style="margin:6px 0 0;color:#9fb2c5;">${escapeHtml(details || 'Active roster player')}</p>
          ${group.note ? `<p style="margin:12px 0 0;color:#dce6ef;">${escapeHtml(group.note)}</p>` : ''}
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          ${leagueRows.join('')}
        </table>
      </section>`);
  }

  textLines.push(
    'Review your roster before the affected player’s next scheduled game.',
    `Manage email preferences: ${accountUrl}`,
  );

  const queueFingerprint = createHash('sha256')
    .update(alerts.map((alert) => alert.queue.id).sort().join(':'))
    .digest('hex')
    .slice(0, 48);

  return {
    subject,
    text: textLines.join('\n'),
    html: buildEmailShell({
      eyebrow: 'Roster Action May Be Needed',
      heading: groups.length === 1
        ? `${groups[0]?.playerName ?? 'A player'} needs attention`
        : `${groups.length} players need attention`,
      intro: 'These confirmed availability changes affect active roster slots that still have games remaining.',
      bodyHtml: `
        ${htmlSections.join('')}
        <p style="margin:4px 0 0;">Review your roster before each affected player’s next scheduled game.</p>
        <p style="margin:16px 0 0;font-size:13px;"><a href="${escapeHtml(accountUrl)}" style="color:#9ed8ff;">Manage injury email preferences</a></p>`,
      footer: 'You received this consolidated email because injury alerts are enabled in your RinkRat Fantasy Account Settings. You can disable them at any time.',
    }),
    category: 'injury-alert-batch',
    idempotencyKey: `injury-batch-${queueFingerprint}`,
  };
}


function buildTestInjuryEmail(options: {
  leagueId: string;
  leagueName: string;
  teamName: string;
}): Omit<TransactionalEmail, 'to'> {
  const reviewUrl = `${getAppBaseUrl()}/leagues/${encodeURIComponent(options.leagueId)}/team`;
  const accountUrl = `${getAppBaseUrl()}/account/settings`;
  const samplePlayers = [
    {
      name: 'Riley Rinkrat',
      details: 'C · VGK',
      status: 'Out',
      note: 'Preview injury: unavailable for the next scheduled game.',
      cycle: 1,
      gamesLeft: 4,
    },
    {
      name: 'Casey Crease',
      details: 'D · MIN',
      status: 'Suspended',
      note: 'Preview injury: this demonstrates a consolidated second alert.',
      cycle: 1,
      gamesLeft: 2,
    },
  ];

  const textLines = [
    'TEST PREVIEW — no roster, injury, or notification settings were changed.',
    '',
    'Two sample active roster players may need attention.',
    '',
  ];
  const htmlSections: string[] = [];

  for (const player of samplePlayers) {
    textLines.push(
      `${player.name} (${player.details}) — ${player.status}`,
      `Details: ${player.note}`,
      `• ${options.leagueName} — ${options.teamName} — Cycle ${player.cycle}, ${player.gamesLeft} games remaining`,
      `  ${reviewUrl}`,
      '',
    );

    htmlSections.push(`
      <section style="margin:0 0 22px;border:1px solid #3a4c60;background:#121d2a;">
        <div style="padding:14px 16px;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">${escapeHtml(player.name)} — ${escapeHtml(player.status)}</h2>
          <p style="margin:6px 0 0;color:#9fb2c5;">${escapeHtml(player.details)}</p>
          <p style="margin:12px 0 0;color:#dce6ef;">${escapeHtml(player.note)}</p>
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="padding:10px;border-top:1px solid #34465a;color:#ffffff;font-weight:700;">${escapeHtml(options.leagueName)}</td>
            <td style="padding:10px;border-top:1px solid #34465a;color:#c5d2df;">${escapeHtml(options.teamName)}</td>
            <td style="padding:10px;border-top:1px solid #34465a;color:#c5d2df;">Cycle ${player.cycle} · ${player.gamesLeft} remaining</td>
            <td style="padding:10px;border-top:1px solid #34465a;"><a href="${escapeHtml(reviewUrl)}" style="color:#9ed8ff;font-weight:700;">Review</a></td>
          </tr>
        </table>
      </section>`);
  }

  textLines.push(
    'This was a test sent from Commissioner Dev Controls. Real injury emails are still controlled by Account Settings and only apply to active roster players.',
    `Manage email preferences: ${accountUrl}`,
  );

  return {
    subject: `[TEST] RinkRat Fantasy injury alert preview`,
    text: textLines.join('\n'),
    html: buildEmailShell({
      eyebrow: 'Test Injury Email Preview',
      heading: 'Preview: 2 players need attention',
      intro: 'This is a safe preview sent from Commissioner Dev Controls. No roster, injury, queue, or notification setting was changed.',
      bodyHtml: `
        <div style="margin:0 0 20px;padding:12px 14px;border:1px solid #d08d38;background:#332413;color:#ffe4b8;font-weight:700;">
          TEST ONLY — the players and injury details below are fictional.
        </div>
        ${htmlSections.join('')}
        <p style="margin:4px 0 0;">Real alerts are sent only for confirmed unavailable players in active roster slots with games remaining.</p>
        <p style="margin:16px 0 0;font-size:13px;"><a href="${escapeHtml(accountUrl)}" style="color:#9ed8ff;">Manage injury email preferences</a></p>`,
      buttonLabel: 'Open My Team',
      buttonUrl: reviewUrl,
      footer: 'This preview bypasses the injury-alert opt-in only because you explicitly requested it from Commissioner Dev Controls. It was sent only to your verified account email.',
    }),
    category: 'injury-alert-preview',
  };
}

async function markAlertsSent(
  alerts: ReadyInjuryAlert[],
  batchId: string,
): Promise<void> {
  const batch = db.batch();

  for (const alert of alerts) {
    const queueRef = db.doc(`injuryEmailQueue/${alert.queue.id}`);
    const logRef = db.doc(`emailNotificationLog/${alert.queue.id}`);
    batch.set(queueRef, {
      status: 'sent',
      batchId,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(logRef, {
      status: 'sent',
      batchId,
      ownerId: alert.queue.ownerId,
      leagueId: alert.queue.leagueId,
      playerId: alert.queue.playerId,
      eventId: alert.queue.eventId,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await batch.commit();
}

async function processOwnerInjuryQueue(
  ownerId: string,
  queueRecords: InjuryQueueRecord[],
  now: number,
  globalAvailabilityRecords: Map<number, AutomaticAvailabilityRecord>,
): Promise<void> {
  const profileSnapshot = await db.doc(`users/${ownerId}`).get();
  const profile = profileSnapshot.data() ?? {};
  let authUser;

  try {
    authUser = await getAuth().getUser(ownerId);
  } catch (error: unknown) {
    const code = asString(asRecord(error)['code']);

    if (code === 'auth/user-not-found') {
      await Promise.all(queueRecords.map((queue) =>
        suppressQueueRecord(queue, 'user-missing'),
      ));
      return;
    }

    throw error;
  }

  if (profile['injuryEmailEnabled'] !== true) {
    await Promise.all(queueRecords.map((queue) =>
      suppressQueueRecord(queue, 'disabled'),
    ));
    return;
  }

  if (!authUser.email || !authUser.emailVerified) {
    await Promise.all(queueRecords.map((queue) =>
      suppressQueueRecord(queue, 'unverified'),
    ));
    return;
  }

  const rosterCache = new Map<string, DocumentData | undefined>();
  const windowCache = new Map<string, InjuryWindowContext | null>();
  const availabilityCache = new Map<string, AutomaticAvailabilityRecord | null>();
  const readyAlerts: ReadyInjuryAlert[] = [];

  for (const queue of queueRecords) {
    if (queue.readyAfterMillis > now) {
      continue;
    }

    const availabilityCacheKey = `${queue.leagueId}:${queue.playerId}`;
    let effectiveAvailability = availabilityCache.get(availabilityCacheKey);

    if (!availabilityCache.has(availabilityCacheKey)) {
      const leagueAvailabilitySnapshot = await db.doc(
        `leagues/${queue.leagueId}/playerAvailability/${queue.playerId}`,
      ).get();
      const leagueAvailabilityData = leagueAvailabilitySnapshot.data();
      const leagueStatus = asString(leagueAvailabilityData?.['status']);

      effectiveAvailability = leagueAvailabilitySnapshot.exists
        ? {
            playerId: queue.playerId,
            status: leagueStatus,
            note: asString(leagueAvailabilityData?.['note']),
            irEligible: leagueAvailabilityData?.['irEligible'] === true,
          }
        : (globalAvailabilityRecords.get(queue.playerId) ?? null);
      availabilityCache.set(availabilityCacheKey, effectiveAvailability);
    }

    if (!effectiveAvailability || !isActionRequiredStatus(effectiveAvailability.status)) {
      await suppressQueueRecord(queue, 'player-no-longer-unavailable');
      continue;
    }

    let rosterData = rosterCache.get(queue.leagueId);

    if (!rosterCache.has(queue.leagueId)) {
      const rosterSnapshot = await db.doc(
        `leagues/${queue.leagueId}/teams/${ownerId}/roster/current`,
      ).get();
      rosterData = rosterSnapshot.data();
      rosterCache.set(queue.leagueId, rosterData);
    }

    const player = getActiveRosterPlayer(rosterData, queue.playerId);

    if (!player) {
      await suppressQueueRecord(queue, 'player-no-longer-active');
      continue;
    }

    if (player.pendingMoveQueued) {
      await suppressQueueRecord(queue, 'move-already-queued');
      continue;
    }

    const windowCacheKey = `${queue.leagueId}:${player.rosterSlotId}:${queue.playerId}`;
    let window = windowCache.get(windowCacheKey);

    if (!windowCache.has(windowCacheKey)) {
      window = await getOwnerWindowContext({
        leagueId: queue.leagueId,
        ownerId,
        playerId: queue.playerId,
        rosterSlotId: player.rosterSlotId,
      });
      windowCache.set(windowCacheKey, window ?? null);
    }

    if (!window || window.status === 'complete' || window.gamesLeft <= 0) {
      await suppressQueueRecord(queue, 'no-actionable-window');
      continue;
    }

    if (queue.waitForGameFinal) {
      if (window.isLive) {
        await updateQueueRecord(queue.id, {
          readyAfter: Timestamp.fromMillis(now + INJURY_QUEUE_RECHECK_MILLISECONDS),
          lastCheckedAt: FieldValue.serverTimestamp(),
          lastKnownLiveGameIds: window.liveGameIds,
        });
        continue;
      }

      if (queue.gameFinalObservedAtMillis <= 0) {
        await updateQueueRecord(queue.id, {
          gameFinalObservedAt: Timestamp.fromMillis(now),
          readyAfter: Timestamp.fromMillis(now + INJURY_BATCH_DELAY_MILLISECONDS),
          lastCheckedAt: FieldValue.serverTimestamp(),
        });
        continue;
      }

      if (
        queue.gameFinalObservedAtMillis + INJURY_BATCH_DELAY_MILLISECONDS > now
      ) {
        continue;
      }
    }

    readyAlerts.push({
      queue: {
        ...queue,
        injuryStatus: effectiveAvailability.status,
        note: effectiveAvailability.note || queue.note,
        irEligible: effectiveAvailability.irEligible,
      },
      window,
    });
  }

  if (readyAlerts.length === 0) {
    return;
  }

  const readyIds = new Set(readyAlerts.map((alert) => alert.queue.id));
  const earliestReadyAnchor = Math.min(
    ...readyAlerts.map((alert) =>
      alert.queue.gameFinalObservedAtMillis || alert.queue.detectedAtMillis || now,
    ),
  );
  const maximumHoldUntil = earliestReadyAnchor + INJURY_MAX_BATCH_HOLD_MILLISECONDS;
  const nearbyPendingReadyTimes = queueRecords
    .filter((queue) =>
      !readyIds.has(queue.id) &&
      queue.readyAfterMillis > now &&
      queue.readyAfterMillis <= now + INJURY_BATCH_DELAY_MILLISECONDS &&
      (!queue.waitForGameFinal || queue.gameFinalObservedAtMillis > 0),
    )
    .map((queue) => queue.readyAfterMillis);

  if (nearbyPendingReadyTimes.length > 0 && now < maximumHoldUntil) {
    const nextBatchTime = Math.min(
      Math.max(...nearbyPendingReadyTimes),
      maximumHoldUntil,
    );

    if (nextBatchTime > now) {
      await Promise.all(readyAlerts.map((alert) =>
        updateQueueRecord(alert.queue.id, {
          readyAfter: Timestamp.fromMillis(nextBatchTime),
          batchHoldReason: 'nearby-owner-alert',
        }),
      ));
      return;
    }
  }

  const batchId = createHash('sha256')
    .update(readyAlerts.map((alert) => alert.queue.id).sort().join(':'))
    .digest('hex');
  const email = buildInjuryBatchEmail(readyAlerts);

  try {
    await sendTransactionalEmail({
      ...email,
      to: authUser.email,
    });
    await markAlertsSent(readyAlerts, batchId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown email error.';

    await Promise.all(readyAlerts.map((alert) =>
      updateQueueRecord(alert.queue.id, {
        status: 'pending',
        attempts: FieldValue.increment(1),
        lastError: message.slice(0, 1000),
        lastAttemptAt: FieldValue.serverTimestamp(),
        readyAfter: Timestamp.fromMillis(now + INJURY_BATCH_DELAY_MILLISECONDS),
      }),
    ));

    throw error;
  }
}
interface AutomaticAvailabilityRecord {
  playerId: number;
  status: string;
  note: string;
  irEligible: boolean;
}

function getAutomaticAvailabilityRecords(
  data: DocumentData | undefined,
): Map<number, AutomaticAvailabilityRecord> {
  const records = new Map<number, AutomaticAvailabilityRecord>();
  const rawRecords = Array.isArray(data?.['records'])
    ? data?.['records'] as unknown[]
    : [];

  for (const rawRecord of rawRecords) {
    const record = asRecord(rawRecord);
    const playerId = typeof record['playerId'] === 'number'
      ? record['playerId']
      : Number(record['playerId']);

    if (!Number.isFinite(playerId) || playerId <= 0) {
      continue;
    }

    records.set(playerId, {
      playerId,
      status: asString(record['status']),
      note: asString(record['note']),
      irEligible: record['irEligible'] === true,
    });
  }

  return records;
}

async function sendInjuryAlertsForLeague(options: {
  eventId: string;
  leagueId: string;
  leagueName: string;
  transitions: AutomaticAvailabilityRecord[];
}): Promise<void> {
  const teamsSnapshot = await db.collection(
    `leagues/${options.leagueId}/teams`,
  ).get();
  const work: Promise<void>[] = [];

  // Each roster is read once, even when several players become unavailable in
  // the same shared injury refresh.
  for (const teamDocument of teamsSnapshot.docs) {
    const ownerId = asString(teamDocument.data()['ownerId']) || teamDocument.id;
    const rosterSnapshot = await db.doc(
      `leagues/${options.leagueId}/teams/${ownerId}/roster/current`,
    ).get();

    for (const transition of options.transitions) {
      const player = getActiveRosterPlayer(
        rosterSnapshot.data(),
        transition.playerId,
      );

      if (!player) {
        continue;
      }

      work.push(queueInjuryAlertForOwner({
        eventId: options.eventId,
        leagueId: options.leagueId,
        leagueName: options.leagueName,
        ownerId,
        teamName: asString(teamDocument.data()['teamName']),
        player,
        status: transition.status,
        note: transition.note,
        irEligible: transition.irEligible,
      }));
    }
  }

  const results = await Promise.allSettled(work);
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    failures.forEach((failure) => {
      console.error('An injury notification could not be queued.', failure.reason);
    });
    throw new Error(`${failures.length} injury notification queue write(s) failed.`);
  }
}


export const processQueuedInjuryEmails = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Los_Angeles',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 1,
    secrets: [RESEND_API_KEY],
  },
  async () => {
    const pendingSnapshot = await db.collection('injuryEmailQueue')
      .where('status', '==', 'pending')
      .limit(INJURY_QUEUE_PROCESS_LIMIT)
      .get();
    const now = Date.now();
    const globalAvailabilitySnapshot = await db.doc('appData/playerAvailability').get();
    const globalAvailabilityRecords = getAutomaticAvailabilityRecords(
      globalAvailabilitySnapshot.data(),
    );
    const byOwner = new Map<string, InjuryQueueRecord[]>();

    for (const document of pendingSnapshot.docs) {
      const queue = normalizeInjuryQueueRecord(document.id, document.data());

      if (!queue) {
        await updateQueueRecord(document.id, {
          status: 'suppressed',
          suppressedReason: 'invalid-queue-record',
          suppressedAt: FieldValue.serverTimestamp(),
        });
        continue;
      }

      const existing = byOwner.get(queue.ownerId) ?? [];
      existing.push(queue);
      byOwner.set(queue.ownerId, existing);
    }

    const failures: unknown[] = [];

    // Process one owner at a time so each person receives one consolidated
    // message and the free email service is not hit with a sudden burst.
    for (const [ownerId, queueRecords] of byOwner) {
      try {
        await processOwnerInjuryQueue(
          ownerId,
          queueRecords,
          now,
          globalAvailabilityRecords,
        );
      } catch (error: unknown) {
        failures.push(error);
        console.error('Unable to process a consolidated injury email.', {
          ownerId,
          queueIds: queueRecords.map((queue) => queue.id),
          error,
        });
      }
    }

    const healthPayload = {
      schemaVersion: 1,
      status: failures.length > 0 ? 'error' : 'healthy',
      pendingQueueCount: pendingSnapshot.size,
      ownerBatchCount: byOwner.size,
      failedOwnerBatchCount: failures.length,
      oldestPendingDetectedAt:
        pendingSnapshot.size > 0
          ? Timestamp.fromMillis(
              Math.min(
                ...[...byOwner.values()]
                  .flat()
                  .map((queue) => queue.detectedAtMillis || now),
              ),
            )
          : null,
      lastRunAt: FieldValue.serverTimestamp(),
      ...(failures.length === 0
        ? {
            lastSuccessfulRunAt: FieldValue.serverTimestamp(),
            lastError: '',
          }
        : {
            lastError: `${failures.length} owner injury email batch(es) failed.`,
          }),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await db.doc('appData/injuryEmailAutomation').set(
      healthPayload,
      { merge: true },
    );

    if (failures.length > 0) {
      throw new Error(`${failures.length} owner injury email batch(es) failed.`);
    }
  },
);


export const sendTestInjuryEmail = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    const userId = request.auth?.uid;

    if (!userId) {
      throw new HttpsError('unauthenticated', 'Sign in before sending a test injury email.');
    }

    const leagueId = asString(asRecord(request.data)['leagueId']);

    if (!leagueId || leagueId.length > 160) {
      throw new HttpsError('invalid-argument', 'A valid league is required.');
    }

    const rateLimitKey = `test-injury-email-${userId}`;
    let rateLimitClaimed = false;

    try {
      // Validate non-secret sender configuration before consuming the cooldown.
      getFromAddress();

      if (!asString(RESEND_API_KEY.value())) {
        throw new HttpsError(
          'failed-precondition',
          'The test email service is not connected to its Resend secret. Redeploy this function after confirming RESEND_API_KEY exists.',
        );
      }

      const [authUser, leagueSnapshot, teamSnapshot] = await Promise.all([
        getAuth().getUser(userId),
        db.doc(`leagues/${leagueId}`).get(),
        db.doc(`leagues/${leagueId}/teams/${userId}`).get(),
      ]);

      if (!leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'The selected league no longer exists.');
      }

      const league = leagueSnapshot.data() ?? {};

      if (asString(league['commissionerId']) !== userId) {
        throw new HttpsError(
          'permission-denied',
          'Only the league commissioner can use this developer email preview.',
        );
      }

      if (!authUser.email || !authUser.emailVerified) {
        throw new HttpsError(
          'failed-precondition',
          'Verify your account email before sending a test injury notification.',
        );
      }

      const rateLimitAccepted = await claimRateLimit(
        rateLimitKey,
        TEST_INJURY_EMAIL_COOLDOWN_SECONDS,
      );

      if (!rateLimitAccepted) {
        throw new HttpsError(
          'resource-exhausted',
          'Please wait about one minute before sending another test injury email.',
        );
      }

      rateLimitClaimed = true;

      const team = teamSnapshot.data() ?? {};
      const leagueName = asString(league['name']) || 'Your Test League';
      const teamName = asString(team['teamName']) || asString(team['name']) || 'Your Team';
      const email = buildTestInjuryEmail({
        leagueId,
        leagueName,
        teamName,
      });

      await sendTransactionalEmail({
        ...email,
        to: authUser.email,
      });

      await db.collection('emailNotificationLog').add({
        status: 'sent-test-preview',
        category: 'injury-alert-preview',
        ownerId: userId,
        leagueId,
        sentAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        accepted: true,
        message: 'A test injury notification was sent to your verified account email.',
      };
    } catch (error: unknown) {
      if (rateLimitClaimed) {
        await releaseRateLimit(rateLimitKey).catch((releaseError: unknown) => {
          console.warn('Unable to release the failed test-email cooldown.', {
            userId,
            leagueId,
            releaseError,
          });
        });
      }

      console.error('sendTestInjuryEmail failed.', {
        userId,
        leagueId,
        error,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error instanceof TransactionalEmailDeliveryError) {
        if (error.status === 401 || error.status === 403) {
          throw new HttpsError(
            'failed-precondition',
            'Resend rejected the credentials for this function. Confirm RESEND_API_KEY and redeploy sendTestInjuryEmail.',
          );
        }

        if (error.status === 422) {
          throw new HttpsError(
            'failed-precondition',
            'Resend rejected the sender address. Confirm notifications@rinkratfantasy.com and the rinkratfantasy.com domain are verified in Resend.',
          );
        }

        if (error.status === 429) {
          throw new HttpsError(
            'resource-exhausted',
            'Resend temporarily rate-limited the test email. Wait a minute and try again.',
          );
        }

        throw new HttpsError(
          'internal',
          `The email provider returned status ${error.status}. Check the sendTestInjuryEmail function log for the provider response.`,
        );
      }

      const message = error instanceof Error ? error.message : '';

      if (message.includes('EMAIL_FROM_ADDRESS')) {
        throw new HttpsError(
          'failed-precondition',
          'The function is missing EMAIL_FROM_ADDRESS. Redeploy it with the project-specific Functions environment file.',
        );
      }

      if (message.includes('RESEND_API_KEY')) {
        throw new HttpsError(
          'failed-precondition',
          'The function cannot access RESEND_API_KEY. Confirm the secret exists and redeploy this function.',
        );
      }

      throw new HttpsError(
        'internal',
        'The test injury email could not be sent. Check the sendTestInjuryEmail function log for the exact server error.',
      );
    }
  },
);

export const requestPasswordResetEmail = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    const email = normalizeEmail(asRecord(request.data)['email']);

    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', 'Enter a valid email address.');
    }

    const emailHash = createHash('sha256').update(email).digest('hex');
    const requestIp = asString(request.rawRequest?.ip) || 'unknown';
    const ipHash = createHash('sha256').update(requestIp).digest('hex');
    const [emailAllowed, ipAllowed] = await Promise.all([
      claimRateLimit(
        `password-reset-${emailHash}`,
        PASSWORD_RESET_COOLDOWN_SECONDS,
      ),
      claimRateLimit(`password-reset-ip-${ipHash}`, 10),
    ]);

    if (!emailAllowed || !ipAllowed) {
      return { accepted: true };
    }

    try {
      const user = await getAuth().getUserByEmail(email);
      const resetLink = await getAuth().generatePasswordResetLink(
        email,
        buildActionCodeSettings(),
      );
      const usernameSnapshot = await db.doc(`users/${user.uid}`).get();
      const username = asString(usernameSnapshot.data()?.['username']) || 'Manager';
      const text = [
        `Hi ${username},`,
        '',
        'A password reset was requested for your RinkRat Fantasy account.',
        '',
        resetLink,
        '',
        'If you did not request this change, ignore this message and your password will remain unchanged.',
      ].join('\n');
      const html = buildEmailShell({
        eyebrow: 'Account Security',
        heading: 'Reset your password',
        intro: 'A password reset was requested for your RinkRat Fantasy account.',
        bodyHtml: '<p style="margin:0;">Use the secure button below to choose a new password. If you did not request this, ignore the email and your password will remain unchanged.</p>',
        buttonLabel: 'Reset Password',
        buttonUrl: resetLink,
        footer: 'For your security, never forward this email or share the reset link.',
      });

      await sendTransactionalEmail({
        to: email,
        subject: 'Reset your RinkRat Fantasy password',
        text,
        html,
        category: 'password-reset',
      });
    } catch (error: unknown) {
      const code = asString(asRecord(error)['code']);

      if (code !== 'auth/user-not-found') {
        console.error('Unable to send password reset email.', error);
      }
    }

    return { accepted: true };
  },
);

export const resendVerificationEmail = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    const userId = request.auth?.uid;

    if (!userId) {
      throw new HttpsError('unauthenticated', 'You must be logged in.');
    }

    const allowed = await claimRateLimit(
      `verification-${userId}`,
      VERIFICATION_COOLDOWN_SECONDS,
    );

    if (!allowed) {
      return { accepted: true, alreadyVerified: false };
    }

    const user = await getAuth().getUser(userId);

    if (!user.email) {
      throw new HttpsError('failed-precondition', 'This account does not have an email address.');
    }

    if (user.emailVerified) {
      return { accepted: true, alreadyVerified: true };
    }

    const profileSnapshot = await db.doc(`users/${userId}`).get();
    const username = asString(profileSnapshot.data()?.['username']) || 'Manager';

    await sendVerificationEmail(
      userId,
      user.email,
      username,
      'verification-resend',
    );

    return { accepted: true, alreadyVerified: false };
  },
);

export const sendWelcomeEmailOnProfileCreated = onDocumentCreated(
  {
    document: 'users/{userId}',
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
    retry: true,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    const snapshot = event.data;

    if (!snapshot) {
      return;
    }

    const profile = snapshot.data();

    if (profile['welcomeEmailSentAt']) {
      return;
    }

    const userId = event.params.userId;
    const user = await getAuth().getUser(userId);

    if (!user.email) {
      return;
    }

    const username = asString(profile['username']) || 'Manager';

    if (user.emailVerified) {
      const appUrl = `${getAppBaseUrl()}/dashboard`;
      await sendTransactionalEmail({
        to: user.email,
        subject: 'Welcome to RinkRat Fantasy',
        text: `Hi ${username},\n\nYour RinkRat Fantasy account was created successfully.\n\nOpen RinkRat Fantasy: ${appUrl}`,
        html: buildEmailShell({
          eyebrow: 'Account Created',
          heading: `Welcome, ${username}`,
          intro: 'Your RinkRat Fantasy account was created successfully.',
          bodyHtml: '<p style="margin:0;">You can now create a league, join with an invite code, and manage your fantasy roster.</p>',
          buttonLabel: 'Open RinkRat Fantasy',
          buttonUrl: appUrl,
          footer: 'Optional injury emails remain disabled until you enable them in Account Settings.',
        }),
        category: 'welcome',
      });
    } else {
      await sendVerificationEmail(
        userId,
        user.email,
        username,
        'welcome-verification',
      );
    }

    await snapshot.ref.set(
      {
        welcomeEmailSentAt: FieldValue.serverTimestamp(),
        welcomeEmailProvider: 'resend',
      },
      { merge: true },
    );
  },
);

export const sendInjuryEmailOnAvailabilityChange = onDocumentWritten(
  {
    document: 'leagues/{leagueId}/playerAvailability/{playerId}',
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    retry: true,
  },
  async (event) => {
    const afterSnapshot = event.data?.after;

    if (!afterSnapshot?.exists) {
      return;
    }

    const beforeData = event.data?.before.exists
      ? event.data.before.data()
      : undefined;
    const afterData = afterSnapshot.data();

    if (!afterData) {
      return;
    }

    const beforeStatus = asString(beforeData?.['status']);
    const afterStatus = asString(afterData['status']);

    if (!isActionRequiredStatus(afterStatus) || isActionRequiredStatus(beforeStatus)) {
      return;
    }

    const leagueId = event.params.leagueId;
    const numericPlayerId = Number(afterData['playerId'] ?? event.params.playerId);

    if (!Number.isFinite(numericPlayerId) || numericPlayerId <= 0) {
      return;
    }

    const leagueSnapshot = await db.doc(`leagues/${leagueId}`).get();
    const leagueName = asString(leagueSnapshot.data()?.['name']) || 'Fantasy Hockey League';

    await sendInjuryAlertsForLeague({
      eventId: event.id,
      leagueId,
      leagueName,
      transitions: [{
        playerId: numericPlayerId,
        status: afterStatus,
        note: asString(afterData['note']),
        irEligible: afterData['irEligible'] === true,
      }],
    });
  },
);


/**
 * Automatic ESPN availability is stored once in /appData/playerAvailability.
 * This trigger detects newly unavailable players in that shared report and
 * checks every active roster, preserving the app's one-refresh-for-all-leagues
 * architecture while still delivering opt-in owner notifications.
 */
export const sendInjuryEmailsOnGlobalAvailabilityChange = onDocumentWritten(
  {
    document: 'appData/playerAvailability',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    retry: true,
  },
  async (event) => {
    const afterSnapshot = event.data?.after;

    if (!afterSnapshot?.exists) {
      return;
    }

    const beforeRecords = getAutomaticAvailabilityRecords(
      event.data?.before.exists ? event.data.before.data() : undefined,
    );
    const afterRecords = getAutomaticAvailabilityRecords(afterSnapshot.data());
    const transitions = [...afterRecords.values()].filter((record) => {
      const previous = beforeRecords.get(record.playerId);
      return isActionRequiredStatus(record.status) &&
        !isActionRequiredStatus(previous?.status);
    });

    if (transitions.length === 0) {
      return;
    }

    const leaguesSnapshot = await db.collection('leagues').get();
    const failures: unknown[] = [];

    // Process leagues sequentially to avoid sudden Firestore/Auth/Resend bursts.
    for (const leagueDocument of leaguesSnapshot.docs) {
      const leagueId = leagueDocument.id;
      const leagueName = asString(leagueDocument.data()['name']) || 'Fantasy Hockey League';

      try {
        await sendInjuryAlertsForLeague({
          eventId: event.id,
          leagueId,
          leagueName,
          transitions,
        });
      } catch (error: unknown) {
        failures.push(error);
        console.error('Unable to process global injury notifications.', {
          leagueId,
          playerIds: transitions.map((transition) => transition.playerId),
          error,
        });
      }
    }

    if (failures.length > 0) {
      throw new Error(`${failures.length} global injury notification batch(es) failed.`);
    }
  },
);
