import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  buildPublicServiceStatusSnapshot,
  normalizeServiceIncidentAdminRecord,
  normalizeServiceIncidentDraft,
  publicServiceIncident,
  SERVICE_INCIDENT_AUDIT_REASON_MINIMUM_LENGTH,
  SERVICE_INCIDENT_PUBLIC_UPDATE_LIMIT,
  SERVICE_INCIDENT_SCHEMA_VERSION,
  type PublicServiceStatusSnapshot,
  type ServiceIncidentAdminRecord,
  type ServiceIncidentDraft,
  type ServiceIncidentOperationsSnapshot,
  type ServiceIncidentPublicUpdate,
  type ServiceStatusBuildIdentity,
} from './shared/core/operations/service-incident.util';
import {
  assessOperationsClientCompatibility,
  normalizeOperationsClientIdentity,
} from './shared/core/operations/operations-client-compatibility.util';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PRIVATE_COLLECTION = 'platformIncidents';
const PUBLIC_COLLECTION = 'publicServiceIncidents';
const ADMIN_INCIDENT_LIMIT = 50;
const PUBLIC_INCIDENT_LIMIT = 40;
const PUBLIC_STATUS_CACHE_MILLISECONDS = 20_000;

let publicStatusCache: { expiresAt: number; value: PublicServiceStatusSnapshot } | null = null;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function buildIdentity(value: unknown, requireDeployableBuild = false): ServiceStatusBuildIdentity {
  const result = normalizeOperationsClientIdentity(value);
  const compatibility = assessOperationsClientCompatibility(result, { requireDeployableBuild });

  if (!compatibility.compatible) {
    throw new HttpsError('failed-precondition', compatibility.message);
  }

  return result;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new HttpsError('invalid-argument', 'The incident revision is invalid. Refresh and try again.');
  }
  return value;
}

function iso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  return null;
}

function incidentFromData(incidentId: string, data: DocumentData | undefined): ServiceIncidentAdminRecord {
  const source = data ?? {};
  const publicUpdates = Array.isArray(source['publicUpdates'])
    ? source['publicUpdates'].map((entry) => {
      const update = record(entry);
      return {
        ...update,
        createdAt: iso(update['createdAt']) ?? update['createdAt'],
      };
    })
    : [];

  return normalizeServiceIncidentAdminRecord(incidentId, {
    ...source,
    publicUpdates,
    nextUpdateAt: iso(source['nextUpdateAt']),
    startedAt: iso(source['startedAt']),
    resolvedAt: iso(source['resolvedAt']),
    createdAt: iso(source['createdAt']),
    updatedAt: iso(source['updatedAt']),
  });
}

function auditReason(value: unknown): string {
  const result = text(value, 800);
  if (result.length < SERVICE_INCIDENT_AUDIT_REASON_MINIMUM_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `Add at least ${SERVICE_INCIDENT_AUDIT_REASON_MINIMUM_LENGTH} characters of incident audit rationale.`,
    );
  }
  return result;
}

function publicUpdateMessage(value: unknown): string {
  const result = text(value, 800);
  if (result.length < 10) {
    throw new HttpsError(
      'invalid-argument',
      'Add a public incident update of at least 10 characters.',
    );
  }
  return result;
}

function internalNote(value: unknown): string {
  return text(value, 4_000);
}

function validateDraft(draft: ServiceIncidentDraft, creating: boolean): void {
  if (draft.publicTitle.length < 6) {
    throw new HttpsError('invalid-argument', 'Add a clear public incident title.');
  }
  if (draft.publicSummary.length < 20) {
    throw new HttpsError('invalid-argument', 'Add a public incident summary of at least 20 characters.');
  }
  if (draft.affectedComponents.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose at least one affected RinkRat component.');
  }
  if (creating && draft.status === 'resolved') {
    throw new HttpsError('invalid-argument', 'Create an active incident before resolving it.');
  }
  if (draft.status !== 'resolved' && (draft.severity === 'p0' || draft.severity === 'p1')) {
    if (!draft.nextUpdateAt) {
      throw new HttpsError('invalid-argument', 'P0 and P1 incidents need a next public update time.');
    }
    if (draft.publicGuidance.length < 10) {
      throw new HttpsError('invalid-argument', 'P0 and P1 incidents need clear manager guidance.');
    }
  }
  if (draft.dataState !== 'live' && draft.dataMessage.length < 10) {
    throw new HttpsError(
      'invalid-argument',
      'Explain whether competition data is delayed, stale read-only, or unavailable.',
    );
  }
  if (draft.status === 'resolved' && draft.publicResolution.length < 20) {
    throw new HttpsError('invalid-argument', 'Resolved incidents need a public resolution summary.');
  }
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  recent = false,
): Promise<string> {
  const adminId = requireFirestoreDocumentId(auth?.uid, 'platform administrator ID', {
    maxBytes: 128,
  });

  if (auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${adminId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError('permission-denied', 'Platform-administrator access is required.');
    }
  }

  if (recent) {
    requireVerifiedRecentAuthentication(auth, 'change a RinkRat service incident');
  }

  return adminId;
}

function publicStoredData(incident: ServiceIncidentAdminRecord): Record<string, unknown> {
  return {
    schemaVersion: SERVICE_INCIDENT_SCHEMA_VERSION,
    incidentId: incident.incidentId,
    revision: incident.revision,
    severity: incident.severity,
    status: incident.status,
    affectedComponents: incident.affectedComponents,
    competitiveImpact: incident.competitiveImpact,
    dataState: incident.dataState,
    dataMessage: incident.dataMessage,
    userAction: incident.userAction,
    publicTitle: incident.publicTitle,
    publicSummary: incident.publicSummary,
    publicGuidance: incident.publicGuidance,
    nextUpdateAt: incident.nextUpdateAt ? Timestamp.fromDate(new Date(incident.nextUpdateAt)) : null,
    publicResolution: incident.publicResolution,
    publicUpdates: incident.publicUpdates,
    startedAt: Timestamp.fromDate(new Date(incident.startedAt)),
    resolvedAt: incident.resolvedAt ? Timestamp.fromDate(new Date(incident.resolvedAt)) : null,
    createdAt: Timestamp.fromDate(new Date(incident.createdAt)),
    updatedAt: Timestamp.fromDate(new Date(incident.updatedAt)),
  };
}

async function loadPublicIncidents(): Promise<ServiceIncidentAdminRecord[]> {
  const snapshot = await db.collection(PUBLIC_COLLECTION)
    .orderBy('updatedAt', 'desc')
    .limit(PUBLIC_INCIDENT_LIMIT)
    .get();

  return snapshot.docs.map((document) => incidentFromData(document.id, document.data()));
}

async function publicSnapshot(force = false): Promise<PublicServiceStatusSnapshot> {
  const now = Date.now();
  if (!force && publicStatusCache && publicStatusCache.expiresAt > now) {
    return publicStatusCache.value;
  }

  const incidents = (await loadPublicIncidents()).map((incident) => publicServiceIncident(incident));
  const value = buildPublicServiceStatusSnapshot(incidents, new Date(now).toISOString());
  publicStatusCache = { expiresAt: now + PUBLIC_STATUS_CACHE_MILLISECONDS, value };
  return value;
}

function invalidatePublicCache(): void {
  publicStatusCache = null;
}

export const getPublicServiceStatus = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 20,
    memory: '256MiB',
    maxInstances: 15,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (): Promise<PublicServiceStatusSnapshot> => publicSnapshot(),
);

export const getServiceIncidentOperations = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ServiceIncidentOperationsSnapshot> => {
    await requirePlatformAdmin(request.auth);
    const build = buildIdentity(request.data?.['build']);
    const snapshot = await db.collection(PRIVATE_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(ADMIN_INCIDENT_LIMIT)
      .get();
    const incidents = snapshot.docs.map((document) => incidentFromData(document.id, document.data()));

    return {
      generatedAt: new Date().toISOString(),
      build,
      incidents,
      publicStatus: buildPublicServiceStatusSnapshot(
        incidents.map((incident) => publicServiceIncident(incident)),
      ),
    };
  },
);

export const createServiceIncident = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '512MiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ServiceIncidentOperationsSnapshot> => {
    const adminId = await requirePlatformAdmin(request.auth, true);
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const draft = normalizeServiceIncidentDraft(input['incident']);
    const reason = auditReason(input['reason']);
    const updateMessage = publicUpdateMessage(input['publicUpdate']);
    const note = internalNote(input['internalNote']);
    validateDraft(draft, true);

    const privateReference = db.collection(PRIVATE_COLLECTION).doc();
    const publicReference = db.doc(`${PUBLIC_COLLECTION}/${privateReference.id}`);
    const changeReference = privateReference.collection('changes').doc();
    const now = new Date();
    const nowIso = now.toISOString();
    const update: ServiceIncidentPublicUpdate = {
      updateId: changeReference.id,
      status: draft.status,
      message: updateMessage,
      createdAt: nowIso,
    };
    const incident: ServiceIncidentAdminRecord = {
      schemaVersion: SERVICE_INCIDENT_SCHEMA_VERSION,
      incidentId: privateReference.id,
      revision: 1,
      ...draft,
      internalTitle: draft.internalTitle || draft.publicTitle,
      internalNotes: note || draft.internalNotes,
      publicUpdates: [update],
      startedAt: nowIso,
      resolvedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      updatedBy: adminId,
    };

    await db.runTransaction(async (transaction) => {
      transaction.create(privateReference, {
        ...incident,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
        nextUpdateAt: incident.nextUpdateAt
          ? Timestamp.fromDate(new Date(incident.nextUpdateAt))
          : null,
      });
      transaction.create(publicReference, publicStoredData(incident));
      transaction.create(changeReference, {
        schemaVersion: 1,
        action: 'incident-created',
        revision: 1,
        reason,
        publicUpdate: updateMessage,
        internalNote: note,
        severity: incident.severity,
        status: incident.status,
        competitiveImpact: incident.competitiveImpact,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        operationsApiVersion: build.operationsApiVersion,
        scoringRulesVersion: build.scoringRulesVersion,
        projectionVersion: build.projectionVersion,
        actorId: adminId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    invalidatePublicCache();
    const incidentsSnapshot = await db.collection(PRIVATE_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(ADMIN_INCIDENT_LIMIT)
      .get();
    const incidents = incidentsSnapshot.docs.map((document) => incidentFromData(document.id, document.data()));
    return {
      generatedAt: new Date().toISOString(),
      build,
      incidents,
      publicStatus: await publicSnapshot(true),
    };
  },
);

export const updateServiceIncident = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '512MiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<ServiceIncidentOperationsSnapshot> => {
    const adminId = await requirePlatformAdmin(request.auth, true);
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const incidentId = requireFirestoreDocumentId(input['incidentId'], 'service incident ID', {
      minimumLength: 10,
      maxBytes: 128,
    });
    const expectedRevision = integer(input['expectedRevision']);
    const draft = normalizeServiceIncidentDraft(input['incident']);
    const reason = auditReason(input['reason']);
    const updateMessage = publicUpdateMessage(input['publicUpdate']);
    const note = internalNote(input['internalNote']);
    validateDraft(draft, false);

    const privateReference = db.doc(`${PRIVATE_COLLECTION}/${incidentId}`);
    const publicReference = db.doc(`${PUBLIC_COLLECTION}/${incidentId}`);
    const changeReference = privateReference.collection('changes').doc();

    await db.runTransaction(async (transaction) => {
      const stored = await transaction.get(privateReference);
      if (!stored.exists) {
        throw new HttpsError('not-found', 'That incident no longer exists.');
      }

      const current = incidentFromData(incidentId, stored.data());
      if (current.revision !== expectedRevision) {
        throw new HttpsError('aborted', 'The incident changed in another session. Refresh before saving.');
      }
      if (current.status === 'resolved') {
        throw new HttpsError(
          'failed-precondition',
          'Resolved incidents are immutable. Create a new incident if the problem returns.',
        );
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const update: ServiceIncidentPublicUpdate = {
        updateId: changeReference.id,
        status: draft.status,
        message: updateMessage,
        createdAt: nowIso,
      };
      const nextUpdates = [update, ...current.publicUpdates]
        .slice(0, SERVICE_INCIDENT_PUBLIC_UPDATE_LIMIT);
      const next: ServiceIncidentAdminRecord = {
        ...current,
        ...draft,
        internalTitle: draft.internalTitle || current.internalTitle || draft.publicTitle,
        internalNotes: note || draft.internalNotes || current.internalNotes,
        revision: current.revision + 1,
        publicUpdates: nextUpdates,
        resolvedAt: draft.status === 'resolved' ? nowIso : null,
        updatedAt: nowIso,
        updatedBy: adminId,
      };

      transaction.set(privateReference, {
        ...next,
        updatedAt: FieldValue.serverTimestamp(),
        nextUpdateAt: next.nextUpdateAt
          ? Timestamp.fromDate(new Date(next.nextUpdateAt))
          : null,
        resolvedAt: next.resolvedAt ? FieldValue.serverTimestamp() : null,
      });
      transaction.set(publicReference, publicStoredData(next));
      transaction.create(changeReference, {
        schemaVersion: 1,
        action: draft.status === 'resolved' ? 'incident-resolved' : 'incident-updated',
        revision: next.revision,
        reason,
        publicUpdate: updateMessage,
        internalNote: note,
        severity: next.severity,
        status: next.status,
        competitiveImpact: next.competitiveImpact,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        operationsApiVersion: build.operationsApiVersion,
        scoringRulesVersion: build.scoringRulesVersion,
        projectionVersion: build.projectionVersion,
        actorId: adminId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    invalidatePublicCache();
    const incidentsSnapshot = await db.collection(PRIVATE_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(ADMIN_INCIDENT_LIMIT)
      .get();
    const incidents = incidentsSnapshot.docs.map((document) => incidentFromData(document.id, document.data()));
    return {
      generatedAt: new Date().toISOString(),
      build,
      incidents,
      publicStatus: await publicSnapshot(true),
    };
  },
);
