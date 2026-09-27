import { Types } from "mongoose";

/**
 * A small in-memory stand-in for the Mongoose model calls services make.
 *
 * Enough of the query language to run a real service end to end in a unit test
 * — equality (with ObjectIds compared by value and `null` matching missing),
 * `$in` `$nin` `$ne` `$gt` `$gte` `$lt` `$lte` `$exists` `$or`, dotted paths and
 * array membership; `$set` `$setOnInsert` `$unset` `$push` `$inc`; `new` and
 * `upsert`; unique indexes, optionally partial, raising Mongo's 11000 with a
 * `keyPattern`. Queries chain `select` / `sort` / `limit` / `lean` and are also
 * awaitable, like a Mongoose query.
 *
 * Not a database: no transactions, no projection, no validation. A test that
 * needs any of those is testing Mongo, not the service.
 */

type Doc = Record<string, unknown>;

type Wrapped = Doc & { toObject: () => Doc };

type UniqueIndex = { fields: string[]; partial?: (doc: Doc) => boolean };

function isObjectId(value: unknown): value is Types.ObjectId {
  return value instanceof Types.ObjectId;
}

function isPlainObject(value: unknown): value is Doc {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isObjectId(value)
  );
}

export function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (isObjectId(value)) return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }

  return value;
}

export function getPath(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;

    // `items.field` on an array of subdocuments reads every item's field, as Mongo does.
    if (Array.isArray(current) && !/^\d+$/.test(key)) {
      return current.flatMap((item) => {
        const value = isPlainObject(item) ? item[key] : undefined;

        return value === undefined ? [] : [value];
      });
    }

    return (current as Doc)[key];
  }, doc);
}

function setPath(doc: Doc, path: string, value: unknown) {
  const keys = path.split(".");
  let current = doc;

  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current[key])) {
      current[key] = {};
    }

    current = current[key] as Doc;
  }

  current[keys[keys.length - 1]!] = clone(value);
}

function unsetPath(doc: Doc, path: string) {
  const keys = path.split(".");
  const parent = getPath(doc, keys.slice(0, -1).join(".")) ?? (keys.length === 1 ? doc : undefined);

  if (isPlainObject(parent)) {
    delete parent[keys[keys.length - 1]!];
  }
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (isObjectId(value)) return value.toString();

  return value;
}

function equals(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (Array.isArray(actual) && !Array.isArray(expected)) {
    return actual.some((item) => equals(item, expected));
  }

  return comparable(actual) === comparable(expected) || String(comparable(actual)) === String(comparable(expected));
}

function matchesOperator(actual: unknown, operator: string, operand: unknown): boolean {
  switch (operator) {
    case "$in":
      return (operand as unknown[]).some((item) => equals(actual, item));
    case "$nin":
      return !(operand as unknown[]).some((item) => equals(actual, item));
    case "$ne":
      return !equals(actual, operand);
    case "$exists":
      return operand ? actual !== undefined : actual === undefined;
    case "$gt":
      return actual !== null && actual !== undefined && (comparable(actual) as number) > (comparable(operand) as number);
    case "$gte":
      return actual !== null && actual !== undefined && (comparable(actual) as number) >= (comparable(operand) as number);
    case "$lt":
      return actual !== null && actual !== undefined && (comparable(actual) as number) < (comparable(operand) as number);
    case "$lte":
      return actual !== null && actual !== undefined && (comparable(actual) as number) <= (comparable(operand) as number);
    default:
      throw new Error(`fake-mongo: unsupported operator ${operator}`);
  }
}

export function matches(doc: Doc, filter: Doc = {}): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return (expected as Doc[]).some((branch) => matches(doc, branch));
    }

    if (key === "$and") {
      return (expected as Doc[]).every((branch) => matches(doc, branch));
    }

    const actual = getPath(doc, key);

    if (isPlainObject(expected) && Object.keys(expected).some((name) => name.startsWith("$"))) {
      return Object.entries(expected).every(([operator, operand]) =>
        matchesOperator(actual, operator, operand),
      );
    }

    return equals(actual, expected);
  });
}

type Update = {
  $inc?: Doc;
  $push?: Doc;
  $set?: Doc;
  $setOnInsert?: Doc;
  $unset?: Doc;
};

function applyUpdate(doc: Doc, update: Update, inserting: boolean) {
  const isOperatorUpdate = Object.keys(update).some((key) => key.startsWith("$"));

  if (!isOperatorUpdate) {
    for (const [key, value] of Object.entries(update)) setPath(doc, key, value);

    return;
  }

  if (inserting) {
    for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) setPath(doc, key, value);
  }

  for (const [key, value] of Object.entries(update.$set ?? {})) setPath(doc, key, value);
  for (const key of Object.keys(update.$unset ?? {})) unsetPath(doc, key);
  for (const [key, value] of Object.entries(update.$inc ?? {})) {
    setPath(doc, key, ((getPath(doc, key) as number) ?? 0) + (value as number));
  }
  for (const [key, value] of Object.entries(update.$push ?? {})) {
    const list = (getPath(doc, key) as unknown[]) ?? [];
    setPath(doc, key, [...list, value]);
  }
}

class FakeQuery<T> implements PromiseLike<T> {
  private sortSpec: Doc | null = null;
  private limitCount: number | null = null;

  constructor(private readonly run: (sort: Doc | null, limit: number | null) => T) {}

  select() {
    return this;
  }

  populate() {
    return this;
  }

  sort(spec: Doc) {
    this.sortSpec = spec;

    return this;
  }

  limit(count: number) {
    this.limitCount = count;

    return this;
  }

  skip() {
    return this;
  }

  lean<R = T>(): Promise<R> {
    return Promise.resolve(this.run(this.sortSpec, this.limitCount) as unknown as R);
  }

  exec() {
    return this.lean();
  }

  then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.lean().then(onFulfilled, onRejected);
  }
}

function sortDocs(docs: Doc[], spec: Doc | null) {
  if (!spec) return docs;

  const entries = Object.entries(spec);

  return [...docs].sort((left, right) => {
    for (const [path, direction] of entries) {
      const a = comparable(getPath(left, path)) as number | string;
      const b = comparable(getPath(right, path)) as number | string;

      if (a === b) continue;
      if (a === undefined || a === null) return 1;
      if (b === undefined || b === null) return -1;

      return (a < b ? -1 : 1) * (Number(direction) < 0 ? -1 : 1);
    }

    return 0;
  });
}

export type FakeModel = ReturnType<typeof fakeModel>;

export function fakeModel(options: { unique?: UniqueIndex[] } = {}) {
  const docs: Doc[] = [];

  function assertUnique(candidate: Doc, ignore?: Doc) {
    for (const index of options.unique ?? []) {
      if (index.partial && !index.partial(candidate)) continue;

      const clash = docs.find(
        (other) =>
          other !== ignore &&
          (!index.partial || index.partial(other)) &&
          index.fields.every((field) => equals(getPath(other, field), getPath(candidate, field))),
      );

      if (clash) {
        const error = new Error(`E11000 duplicate key (${index.fields.join(", ")})`) as Error & {
          code: number;
          keyPattern: Doc;
        };

        error.code = 11000;
        error.keyPattern = Object.fromEntries(index.fields.map((field) => [field, 1]));
        throw error;
      }
    }
  }

  function withDefaults(input: Doc) {
    const now = new Date();

    return { _id: new Types.ObjectId(), createdAt: now, updatedAt: now, ...clone(input) };
  }

  const model = {
    docs,

    reset(seed: Doc[] = []) {
      docs.splice(0, docs.length, ...seed.map((doc) => withDefaults(doc)));
    },

    async create<T extends Doc | Doc[]>(input: T): Promise<T extends Doc[] ? Wrapped[] : Wrapped> {
      const inputs: Doc[] = Array.isArray(input) ? input : [input];
      const created = inputs.map((one) => {
        const doc = withDefaults(one);

        assertUnique(doc);
        docs.push(doc);

        return doc;
      });

      const wrap = (doc: Doc): Wrapped => ({ ...clone(doc), toObject: () => clone(doc) });

      return (Array.isArray(input) ? created.map(wrap) : wrap(created[0]!)) as T extends Doc[]
        ? Wrapped[]
        : Wrapped;
    },

    async insertMany(input: Doc[]) {
      return this.create(input);
    },

    find(filter: Doc = {}) {
      return new FakeQuery((sort, limit) => {
        const found = sortDocs(docs.filter((doc) => matches(doc, filter)), sort);

        return clone(limit === null ? found : found.slice(0, limit));
      });
    },

    findOne(filter: Doc = {}) {
      return new FakeQuery((sort) => clone(sortDocs(docs.filter((doc) => matches(doc, filter)), sort)[0] ?? null));
    },

    findById(id: unknown) {
      return model.findOne({ _id: id });
    },

    findOneAndUpdate(filter: Doc, update: Update, opts: { new?: boolean; upsert?: boolean } = {}) {
      return new FakeQuery(() => {
        let doc = docs.find((candidate) => matches(candidate, filter));
        const before = doc ? clone(doc) : null;

        if (!doc && opts.upsert) {
          const seed = Object.fromEntries(
            Object.entries(filter).filter(([key, value]) => !key.startsWith("$") && !isPlainObject(value)),
          );
          const next = withDefaults(seed);

          applyUpdate(next, update, true);
          assertUnique(next);
          docs.push(next);

          return clone(next);
        }

        if (!doc) return null;

        const next = clone(doc);

        applyUpdate(next, update, false);
        assertUnique(next, doc);
        Object.assign(doc, next);
        doc = next;

        return opts.new ? clone(doc) : before;
      });
    },

    async updateOne(filter: Doc, update: Update, opts: { upsert?: boolean } = {}) {
      const doc = docs.find((candidate) => matches(candidate, filter));

      if (!doc) {
        if (opts.upsert) {
          await model.findOneAndUpdate(filter, update, { upsert: true }).lean();

          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }

        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }

      const next = clone(doc);

      applyUpdate(next, update, false);
      assertUnique(next, doc);
      Object.assign(doc, next);

      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },

    async updateMany(filter: Doc, update: Update) {
      const targets = docs.filter((doc) => matches(doc, filter));

      for (const doc of targets) applyUpdate(doc, update, false);

      return { matchedCount: targets.length, modifiedCount: targets.length };
    },

    async deleteMany(filter: Doc = {}) {
      const keep = docs.filter((doc) => !matches(doc, filter));
      const deletedCount = docs.length - keep.length;

      docs.splice(0, docs.length, ...keep);

      return { deletedCount };
    },

    async countDocuments(filter: Doc = {}) {
      return docs.filter((doc) => matches(doc, filter)).length;
    },

    async exists(filter: Doc = {}) {
      const doc = docs.find((candidate) => matches(candidate, filter));

      return doc ? { _id: doc._id } : null;
    },
  };

  return model;
}
