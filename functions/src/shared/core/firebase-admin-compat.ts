import {
  DocumentData,
  DocumentReference as AdminDocumentReference,
  CollectionReference as AdminCollectionReference,
  Query as AdminQuery,
  Firestore,
  FieldValue,
  Transaction as AdminTransaction,
  WriteBatch as AdminWriteBatch,
} from 'firebase-admin/firestore';

export type DocumentReference<T extends DocumentData = DocumentData> =
  AdminDocumentReference<T>;
export type CollectionReference<T extends DocumentData = DocumentData> =
  AdminCollectionReference<T>;
export type Query<T extends DocumentData = DocumentData> = AdminQuery<T>;

export interface DocumentSnapshot<T extends DocumentData = DocumentData> {
  readonly id: string;
  readonly ref: DocumentReference<T>;
  exists(): boolean;
  data(): T | undefined;
}

export interface QueryDocumentSnapshot<T extends DocumentData = DocumentData>
  extends DocumentSnapshot<T> {
  data(): T;
}

export interface QuerySnapshot<T extends DocumentData = DocumentData> {
  readonly docs: QueryDocumentSnapshot<T>[];
  readonly empty: boolean;
  readonly size: number;
}

interface WhereConstraint {
  kind: 'where';
  fieldPath: string;
  opStr: FirebaseFirestore.WhereFilterOp;
  value: unknown;
}

interface OrderByConstraint {
  kind: 'orderBy';
  fieldPath: string;
  directionStr?: FirebaseFirestore.OrderByDirection;
}

interface LimitConstraint {
  kind: 'limit';
  limit: number;
}

type QueryConstraint = WhereConstraint | OrderByConstraint | LimitConstraint;

type ReferenceParent =
  | Firestore
  | DocumentReference
  | CollectionReference;

function isFirestore(value: ReferenceParent): value is Firestore {
  return typeof (value as Firestore).collectionGroup === 'function' &&
    typeof (value as Firestore).doc === 'function' &&
    !('path' in value);
}

function buildPath(parent: ReferenceParent, segments: string[]): string {
  const suffix = segments.filter(Boolean).join('/');

  if (isFirestore(parent)) {
    return suffix;
  }

  return suffix ? `${parent.path}/${suffix}` : parent.path;
}

function wrapDocumentSnapshot<T extends DocumentData>(
  snapshot: FirebaseFirestore.DocumentSnapshot<T>,
): DocumentSnapshot<T> {
  return {
    id: snapshot.id,
    ref: snapshot.ref,
    exists: () => snapshot.exists,
    data: () => snapshot.data(),
  };
}

function wrapQuerySnapshot<T extends DocumentData>(
  snapshot: FirebaseFirestore.QuerySnapshot<T>,
): QuerySnapshot<T> {
  return {
    docs: snapshot.docs.map((document) => ({
      id: document.id,
      ref: document.ref,
      exists: () => true,
      data: () => document.data(),
    })),
    empty: snapshot.empty,
    size: snapshot.size,
  };
}

export function doc(
  parent: ReferenceParent,
  ...pathSegments: string[]
): DocumentReference {
  if (parent instanceof AdminCollectionReference) {
    if (pathSegments.length !== 1) {
      throw new Error('Document references from a collection require exactly one id.');
    }

    return parent.doc(pathSegments[0]);
  }

  const path = buildPath(parent, pathSegments);
  const firestore = isFirestore(parent) ? parent : parent.firestore;
  return firestore.doc(path);
}

export function collection(
  parent: ReferenceParent,
  ...pathSegments: string[]
): CollectionReference {
  const path = buildPath(parent, pathSegments);
  const firestore = isFirestore(parent) ? parent : parent.firestore;
  return firestore.collection(path);
}

export function collectionGroup(
  firestore: Firestore,
  collectionId: string,
): Query {
  return firestore.collectionGroup(collectionId);
}

export function where(
  fieldPath: string,
  opStr: FirebaseFirestore.WhereFilterOp,
  value: unknown,
): QueryConstraint {
  return { kind: 'where', fieldPath, opStr, value };
}

export function orderBy(
  fieldPath: string,
  directionStr?: FirebaseFirestore.OrderByDirection,
): QueryConstraint {
  return { kind: 'orderBy', fieldPath, directionStr };
}

export function limit(limitCount: number): QueryConstraint {
  return { kind: 'limit', limit: limitCount };
}

export function query<T extends DocumentData>(
  base: Query<T> | CollectionReference<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  let next: Query<T> = base;

  for (const constraint of constraints) {
    if (constraint.kind === 'where') {
      next = next.where(constraint.fieldPath, constraint.opStr, constraint.value);
    } else if (constraint.kind === 'orderBy') {
      next = next.orderBy(constraint.fieldPath, constraint.directionStr);
    } else {
      next = next.limit(constraint.limit);
    }
  }

  return next;
}

export async function getDoc<T extends DocumentData>(
  reference: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  return wrapDocumentSnapshot(await reference.get());
}

export async function getDocs<T extends DocumentData>(
  reference: Query<T> | CollectionReference<T>,
): Promise<QuerySnapshot<T>> {
  return wrapQuerySnapshot(await reference.get());
}

export class Transaction {
  constructor(private readonly transaction: AdminTransaction) {}

  async get<T extends DocumentData>(
    reference: DocumentReference<T>,
  ): Promise<DocumentSnapshot<T>>;
  async get<T extends DocumentData>(
    reference: Query<T> | CollectionReference<T>,
  ): Promise<QuerySnapshot<T>>;
  async get<T extends DocumentData>(
    reference: DocumentReference<T> | Query<T> | CollectionReference<T>,
  ): Promise<DocumentSnapshot<T> | QuerySnapshot<T>> {
    const snapshot = await this.transaction.get(reference as DocumentReference<T>);

    if ('docs' in snapshot) {
      return wrapQuerySnapshot(
        snapshot as unknown as FirebaseFirestore.QuerySnapshot<T>,
      );
    }

    return wrapDocumentSnapshot(snapshot as FirebaseFirestore.DocumentSnapshot<T>);
  }

  set<T extends DocumentData>(
    reference: DocumentReference<T>,
    data: Partial<T> | DocumentData,
    options?: FirebaseFirestore.SetOptions,
  ): Transaction {
    if (options) {
      this.transaction.set(reference, data as T, options);
    } else {
      this.transaction.set(reference, data as T);
    }

    return this;
  }

  update(
    reference: DocumentReference,
    data: DocumentData,
  ): Transaction {
    this.transaction.update(reference, data);
    return this;
  }

  delete(reference: DocumentReference): Transaction {
    this.transaction.delete(reference);
    return this;
  }
}

export async function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return firestore.runTransaction((transaction) =>
    updateFunction(new Transaction(transaction))
  );
}

class WriteBatch {
  constructor(private readonly batch: AdminWriteBatch) {}

  set(
    reference: DocumentReference,
    data: DocumentData,
    options?: FirebaseFirestore.SetOptions,
  ): WriteBatch {
    if (options) {
      this.batch.set(reference, data, options);
    } else {
      this.batch.set(reference, data);
    }

    return this;
  }

  update(reference: DocumentReference, data: DocumentData): WriteBatch {
    this.batch.update(reference, data);
    return this;
  }

  delete(reference: DocumentReference): WriteBatch {
    this.batch.delete(reference);
    return this;
  }

  commit(): Promise<FirebaseFirestore.WriteResult[]> {
    return this.batch.commit();
  }
}

export function writeBatch(firestore: Firestore): WriteBatch {
  return new WriteBatch(firestore.batch());
}

export function serverTimestamp(): FieldValue {
  return FieldValue.serverTimestamp();
}

export function increment(value: number): FieldValue {
  return FieldValue.increment(value);
}

export async function setDoc(
  reference: DocumentReference,
  data: DocumentData,
  options?: FirebaseFirestore.SetOptions,
): Promise<FirebaseFirestore.WriteResult> {
  if (options) {
    return reference.set(data, options);
  }

  return reference.set(data);
}

export async function updateDoc(
  reference: DocumentReference,
  data: DocumentData,
): Promise<FirebaseFirestore.WriteResult> {
  return reference.update(data);
}

export function onSnapshot<T extends DocumentData>(
  reference: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): () => void;
export function onSnapshot<T extends DocumentData>(
  reference: DocumentReference<T>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void,
): () => void;
export function onSnapshot<T extends DocumentData>(
  reference: DocumentReference<T> | Query<T> | CollectionReference<T>,
  onNext: ((snapshot: DocumentSnapshot<T>) => void) | ((snapshot: QuerySnapshot<T>) => void),
  onError?: (error: Error) => void,
): () => void {
  return reference.onSnapshot(
    (snapshot) => {
      if ('docs' in snapshot) {
        (onNext as (value: QuerySnapshot<T>) => void)(
          wrapQuerySnapshot(snapshot as FirebaseFirestore.QuerySnapshot<T>),
        );
      } else {
        (onNext as (value: DocumentSnapshot<T>) => void)(
          wrapDocumentSnapshot(snapshot as FirebaseFirestore.DocumentSnapshot<T>),
        );
      }
    },
    onError,
  );
}
