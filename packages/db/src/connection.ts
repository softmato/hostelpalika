import { attachDatabasePool } from "@vercel/functions";
import mongoose from "mongoose";

// Model calls inside `connection.transaction(fn)` ride its session without
// threading `{ session }` through every helper (billing run, R28).
mongoose.set("transactionAsyncLocalStorage", true);

type CachedConnection = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as typeof globalThis & {
  mongooseConnection?: CachedConnection;
};

const cached = globalForMongoose.mongooseConnection ?? {
  conn: null,
  promise: null,
};

globalForMongoose.mongooseConnection = cached;

/**
 * Cached Mongoose connection (one per process). Environment loading is the
 * caller's responsibility — apps/web loads the repo-root .env via @next/env,
 * standalone scripts load it themselves before importing this module.
 */
export async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI ?? process.env.DATABASE_URL;

  if (!uri) {
    throw new Error("MONGODB_URI (or DATABASE_URL) is required to connect to MongoDB.");
  }

  /*
   * A failed connect is forgotten, not cached. Kept, one refused handshake would
   * be replayed to every later request on this warm instance until it recycled —
   * a single blip in the Atlas proxy became a run of 500s across unrelated routes.
   */
  /*
   * Every warm serverless instance holds its own pool, and M0 refuses new
   * connections at 500 cluster-wide. The driver default (100 per pool, never
   * idled out) let a burst of instances hold the whole budget — Atlas alerted
   * on 2026-09-22. A request past the cap waits for a socket; it does not fail.
   * Fluid runs many requests per instance, so 5 is plenty; each instance also
   * holds ~2 monitoring sockets per replica-set member on top of this.
   *
   * `attachDatabasePool` closes idle sockets before Vercel suspends the
   * instance, instead of leaving them open on a frozen process until Atlas
   * times them out. A no-op off Vercel (scripts, local dev).
   */
  cached.promise ??= mongoose
    .connect(uri, {
      // Off: on, every cold instance re-sent a createCollection and createIndex
      // per model — ~435 commands through those 5 sockets on an M0 that serves
      // 100 operations a second — and a screen's burst of requests queued
      // behind them past the app's 20-second timeout. Indexes are built on
      // purpose instead: `npm --prefix apps/web run db:indexes`.
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      maxIdleTimeMS: 30_000,
      maxPoolSize: 5,
    })
    .then((connection) => {
      // An optimisation, so it must never be the reason a connect fails: a
      // throw here used to reject a connection that had already succeeded.
      try {
        attachDatabasePool(connection.connection.getClient());
      } catch (error) {
        console.warn("attachDatabasePool failed; keeping the connection", error);
      }
      return connection;
    })
    .catch((error: unknown) => {
      cached.promise = null;
      throw error;
    });

  cached.conn = await cached.promise;
  return cached.conn;
}

export async function disconnectFromDatabase() {
  if (cached.conn) {
    await cached.conn.disconnect();
    cached.conn = null;
    cached.promise = null;
  }
}
