import {
  experimental_ensureQueryHandle,
  experimental_getQueryHandleData,
  experimental_queryHandle,
  experimental_queryHandleAsync,
} from './handles'
import { noop } from './utils'
import type {
  DefinedQueryHandle,
  InferQueryHandleData,
  QueryHandle,
  QueryHandleArgs,
  QueryHandleFactory,
} from './handles'
import type { QueryClient } from './queryClient'

// TYPES

type QueryHandleEntryKind = 'start' | 'wait' | 'ensure'

declare const entryFactory: unique symbol
declare const entryKind: unique symbol
declare const dependentEntry: unique symbol

/**
 * A query that `experimental_loadQueryHandles` started. It is opaque: read its handle and data
 * from what `experimental_loadQueryHandles` resolves to.
 */
export interface QueryHandleEntry<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
  TKind extends QueryHandleEntryKind = QueryHandleEntryKind,
> {
  /**
   * The factory that started the query. It exists only in types.
   */
  readonly [entryFactory]: TFactory
  /**
   * Whether the call waits for the query, and for which data. It exists only in types.
   */
  readonly [entryKind]: TKind
}

/**
 * A query that starts once another query's data is in the cache, from `after`.
 */
export interface DependentQueryHandleEntry<
  TEntry extends AnyQueryHandleEntry | null = AnyQueryHandleEntry | null,
> {
  /**
   * The entry the `after` callback returns. It exists only in types.
   */
  readonly [dependentEntry]: TEntry
}

type AnyQueryHandleEntry =
  | QueryHandleEntry<any, QueryHandleEntryKind>
  | DependentQueryHandleEntry<any>

type AwaitedQueryHandleEntry =
  | QueryHandleEntry<any, 'wait' | 'ensure'>
  | DependentQueryHandleEntry<QueryHandleEntry<any, 'wait' | 'ensure'> | null>

type HandleOfEntry<TEntry> = TEntry extends null
  ? null
  : TEntry extends QueryHandleEntry<infer TFactory, infer TKind>
    ? TKind extends 'start'
      ? QueryHandle<TFactory>
      : DefinedQueryHandle<TFactory>
    : TEntry extends DependentQueryHandleEntry<infer TInner>
      ? HandleOfEntry<TInner>
      : never

type DataOfEntry<TEntry> = TEntry extends null
  ? null
  : TEntry extends QueryHandleEntry<infer TFactory, 'wait' | 'ensure'>
    ? InferQueryHandleData<TFactory>
    : TEntry extends DependentQueryHandleEntry<infer TInner>
      ? DataOfEntry<TInner>
      : never

type HasData<TEntry> =
  TEntry extends QueryHandleEntry<any, 'wait' | 'ensure'>
    ? true
    : TEntry extends DependentQueryHandleEntry<infer TInner>
      ? HasData<TInner>
      : false

/**
 * What `experimental_loadQueryHandles` resolves to: a handle for every entry, and the data of
 * every entry it waited for.
 */
export interface LoadedQueryHandles<
  TEntries extends Record<string, AnyQueryHandleEntry>,
> {
  /**
   * The handles, by the keys the callback returned. Return them from a loader.
   */
  handles: { [TKey in keyof TEntries]: HandleOfEntry<TEntries[TKey]> }
  /**
   * The data of the entries from `wait`, `ensure` and `after`, like `useSuspenseQuery`'s `data`.
   */
  data: {
    [
      TKey in keyof TEntries as true extends HasData<TEntries[TKey]>
        ? TKey
        : never
    ]: DataOfEntry<TEntries[TKey]>
  }
}

/**
 * Starts the queries of one `experimental_loadQueryHandles` call. Its functions work only while
 * a callback of that call runs.
 */
export interface QueryHandlesBuilder {
  /**
   * Starts a query without waiting, like `experimental_queryHandle`.
   */
  start: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...input: QueryHandleArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'start'>
  /**
   * Starts a query and waits for fresh data, like `experimental_queryHandleAsync`.
   */
  wait: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...input: QueryHandleArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'wait'>
  /**
   * Starts a query and waits for any data, even stale data, like `experimental_ensureQueryHandle`.
   */
  ensure: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...input: QueryHandleArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'ensure'>
  /**
   * Starts a query that needs another query's data, once that data is in the cache. The other
   * queries don't wait for it to start. Return `null` to start nothing.
   */
  after: <
    TParent extends AwaitedQueryHandleEntry,
    TEntry extends AnyQueryHandleEntry | null,
  >(
    parent: TParent,
    start: (data: DataOfEntry<TParent>) => TEntry,
  ) => DependentQueryHandleEntry<TEntry>
}

// FUNCTIONS

interface SettledEntry {
  handle: QueryHandle | null
  hasData: boolean
  data?: unknown
}

interface EntryState {
  promise: Promise<SettledEntry>
  awaited: boolean
}

/**
 * Tells promises apart from entries.
 * @param value - What a callback returned.
 * @returns Whether it has a `then` method.
 */
function isThenable(value: unknown): boolean {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function'
}

/**
 * Starts a loader's queries together and waits for the ones it needs. The callback starts every
 * query before anything waits: it can't be async, and its `start`, `wait`, `ensure` and `after`
 * throw once it returns. So no query waits for another unless `after` says it needs that query's
 * data. Resolves to the handles, and to the data of the entries it waited for. Rejects as soon as
 * a query it waits for fails, or a callback throws, like `notFound()`.
 * @param queryClient - The client to start the queries on.
 * @param start - Starts the queries and returns their entries by key.
 * @returns A promise of the handles and the data.
 * @example
 * ```ts
 * // in a route loader
 * const { handles, data } = await experimental_loadQueryHandles(queryClient, (q) => ({
 *   viewer: q.start(viewerQuery),
 *   post: q.wait(postQuery, { id: params.id }),
 * }))
 * if (!data.post) throw notFound()
 * return handles
 * ```
 */
export async function experimental_loadQueryHandles<
  TEntries extends Record<string, AnyQueryHandleEntry>,
>(
  queryClient: QueryClient,
  start: (q: QueryHandlesBuilder) => TEntries,
): Promise<LoadedQueryHandles<TEntries>> {
  const states = new WeakMap<object, EntryState>()
  const waiting: Array<Promise<SettledEntry>> = []
  let open = false

  const run = <TResult>(callback: () => TResult): TResult => {
    open = true
    try {
      const result = callback()
      if (isThenable(result)) {
        throw new Error(
          'experimental_loadQueryHandles: start queries synchronously. A callback must return entries, not a promise.',
        )
      }
      return result
    } finally {
      open = false
    }
  }

  const assertOpen = () => {
    if (!open) {
      throw new Error(
        'experimental_loadQueryHandles: start queries only while its callback runs, before anything waits.',
      )
    }
  }

  const addEntry = (promise: Promise<SettledEntry>, awaited: boolean) => {
    promise.catch(noop)
    if (awaited) waiting.push(promise)
    const entry = {}
    states.set(entry, { promise, awaited })
    return entry as never
  }

  const withData = (
    factory: QueryHandleFactory,
    handle: Promise<DefinedQueryHandle>,
  ) =>
    handle.then((resolved) => ({
      handle: resolved,
      hasData: true,
      data: experimental_getQueryHandleData(queryClient, factory, resolved),
    }))

  const q: QueryHandlesBuilder = {
    start: (factory, ...input) => {
      assertOpen()
      const handle = experimental_queryHandle(queryClient, factory, ...input)
      return addEntry(Promise.resolve({ handle, hasData: false }), false)
    },
    wait: (factory, ...input) => {
      assertOpen()
      const handle = experimental_queryHandleAsync(
        queryClient,
        factory,
        ...input,
      )
      return addEntry(withData(factory, handle), true)
    },
    ensure: (factory, ...input) => {
      assertOpen()
      const handle = experimental_ensureQueryHandle(
        queryClient,
        factory,
        ...input,
      )
      return addEntry(withData(factory, handle), true)
    },
    after: (parent, startDependent) => {
      assertOpen()
      const parentState = states.get(parent)
      if (!parentState?.awaited) {
        throw new Error(
          'experimental_loadQueryHandles: `after` takes an entry from `wait`, `ensure` or `after` of the same call.',
        )
      }
      const promise = parentState.promise.then((settled) => {
        const entry = run(() => startDependent(settled.data as never))
        if (entry === null) return { handle: null, hasData: true, data: null }
        const state = states.get(entry)
        if (!state) {
          throw new Error(
            'experimental_loadQueryHandles: `after` must return an entry of the same call, or null.',
          )
        }
        return state.promise
      })
      return addEntry(promise, true)
    },
  }

  const entries = run(() => start(q))
  const keyed = Object.entries(entries).map(([key, entry]) => {
    const state = states.get(entry)
    if (!state) {
      throw new Error(
        `experimental_loadQueryHandles: "${key}" is not an entry of this call.`,
      )
    }
    return [key, state] as const
  })

  // `after` adds entries while others settle, so wait until no new ones appear
  for (let count = -1; count !== waiting.length;) {
    count = waiting.length
    await Promise.all(waiting)
  }

  const handles: Record<string, unknown> = {}
  const data: Record<string, unknown> = {}
  for (const [key, state] of keyed) {
    const settled = await state.promise
    handles[key] = settled.handle
    if (settled.hasData) data[key] = settled.data
  }
  return { handles, data } as LoadedQueryHandles<TEntries>
}
