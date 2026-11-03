import mongoose from "mongoose";

/**
 * Runs `fn` in one MongoDB transaction. Model calls inside ride its session on
 * their own (`transactionAsyncLocalStorage`, set in packages/db/src/connection.ts),
 * so helpers need no `{ session }` threaded through them. Retries on a transient
 * error are the driver's.
 */
export function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(fn);
}
