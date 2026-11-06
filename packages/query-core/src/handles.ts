import { hashQueryKeyByOptions, noop } from './utils'
import type { QueryClient } from './queryClient'
import type {
  InferDataFromTag,
  QueryKey,
  QueryObserverOptions,
  StaleTime,
} from './types'

// TYPES

/**
 * The options a query factory returns, usually from `queryOptions` or `infiniteQueryOptions`.
 */
type QueryFactoryOptions = Pick<
  QueryObserverOptions<any, any, any, any, any>,
  'queryKey' | 'queryKeyHashFn' | 'select'
>

/**
 * A function of zero or one argument that returns a query's options, usually with `queryOptions`
 * or `infiniteQueryOptions`. Its argument is the query's input, which handles carry.
 */
export type QueryHandleFactory = (input?: any) => QueryFactoryOptions

/**
 * The input of a query factory: its first parameter, or `undefined` if it takes none.
 */
type QueryHandleInput<TFactory extends QueryHandleFactory> =
  Parameters<TFactory> extends [] ? undefined : Parameters<TFactory>[0]

/**
 * The arguments the handle functions take after the factory: its input, if it takes one. A
 * factory's other parameters are left out, because a handle only carries the input, so
 * `experimental_fromHandle` couldn't pass them on.
 */
type QueryHandleArgs<TFactory extends QueryHandleFactory> =
  Parameters<TFactory> extends []
    ? []
    : Parameters<TFactory> extends [infer TInput, ...Array<any>]
      ? [input: TInput]
      : [input?: Parameters<TFactory>[0]]

type PlainTuple<
  TQueryKey extends ReadonlyArray<unknown>,
  TRequired extends Array<unknown> = [],
  TOptional extends Array<unknown> = [],
> = [...TRequired, ...TOptional]['length'] extends TQueryKey['length']
  ? [...TRequired, ...TOptional, unknown]['length'] extends TQueryKey['length']
    ? PlainTuple<
        TQueryKey,
        TRequired,
        [...TOptional, TQueryKey[[...TRequired, ...TOptional]['length']]]
      >
    : [...TRequired, ...Partial<TOptional>]
  : PlainTuple<TQueryKey, [...TRequired, TQueryKey[TRequired['length']]]>

type PlainQueryKey<TQueryKey extends ReadonlyArray<unknown>> =
  number extends TQueryKey['length']
    ? ReadonlyArray<TQueryKey[number]>
    : Readonly<PlainTuple<TQueryKey>>

/**
 * The `queryKey` of a factory's query as a plain readonly tuple, without the data tag that
 * `queryOptions` adds, so a handle stays a plain serializable object for routers that check
 * loader data.
 */
type QueryHandleKey<TFactory extends QueryHandleFactory> = PlainQueryKey<
  ReturnType<TFactory>['queryKey']
>

/**
 * A small serializable reference to a query, from `experimental_loadQueryHandles` or
 * `experimental_waterfallHandle`. Pass it to the component that reads the query, and rebuild the
 * query's options there with `experimental_fromHandle(factory, handle)`. It carries no data:
 * readers get the query's data from the cache.
 *
 * Handles of two factories only mix when their keys have the same type. Declare keys with
 * `as const` to keep factories with the same input and data apart.
 */
export interface QueryHandle<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
> {
  /**
   * The key of the query the handle refers to.
   */
  readonly queryKey: QueryHandleKey<TFactory>
  /**
   * The query's input: the argument its factory takes.
   */
  readonly input: QueryHandleInput<TFactory>
}

/**
 * The options `experimental_fromHandle` returns: the factory's options for the handle's input.
 */
export type FromHandleOptions<TFactory extends QueryHandleFactory> =
  ReturnType<TFactory>

type FactoryData<TOptions> = 'select' extends keyof TOptions
  ? TOptions extends { select?: (data: any) => infer TData }
    ? TData
    : never
  : TOptions extends { queryKey: QueryKey }
    ? InferDataFromTag<unknown, TOptions['queryKey']>
    : unknown

/**
 * The data a reader of a factory's query gets, the same as `useSuspenseQuery`'s `data`: what the
 * factory's `select` returns, or else the `queryFn`'s data, which is `InfiniteData` for an infinite
 * factory. Use it to type a prop that takes the data. Pass a factory type or a handle type.
 * @example
 * ```ts
 * function PostTitle(props: { post: experimental_InferQueryHandleData<typeof postQuery> }) {
 *   return <h1>{props.post.title}</h1>
 * }
 * ```
 */
export type InferQueryHandleData<
  T extends QueryHandleFactory | QueryHandle<any>,
> = T extends QueryHandleFactory
  ? FactoryData<ReturnType<T>>
  : T extends QueryHandle<infer TFactory>
    ? FactoryData<ReturnType<TFactory>>
    : never

type QueryHandleEntryKind = 'prefetch' | 'fetch' | 'ensure'

/**
 * Options for one infinite query that `experimental_loadQueryHandles` starts.
 */
export interface QueryHandleLoadOptions {
  /**
   * The number of pages the load fetches, starting from the first, like the `pages` option of
   * `queryClient.infiniteQuery`. Readers don't get it, so their refetches fetch every page they
   * have.
   */
  pages?: number
}

/**
 * The arguments `prefetch`, `fetch` and `ensure` take after the factory: its input, if it takes one,
 * and for an infinite factory, options like `pages`.
 */
type QueryHandleLoadArgs<TFactory extends QueryHandleFactory> =
  ReturnType<TFactory> extends { initialPageParam: unknown }
    ? Parameters<TFactory> extends []
      ? [input?: undefined, options?: QueryHandleLoadOptions]
      : [...QueryHandleArgs<TFactory>, options?: QueryHandleLoadOptions]
    : QueryHandleArgs<TFactory>

declare const entryFactory: unique symbol
declare const entryKind: unique symbol
declare const entryNull: unique symbol

/**
 * A query that `experimental_loadQueryHandles` started. It is opaque: its handle and data come
 * back when `experimental_loadQueryHandles` resolves.
 */
export interface QueryHandleEntry<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
  TKind extends QueryHandleEntryKind = QueryHandleEntryKind,
  TNull extends null = never,
> {
  /**
   * The factory that started the query. It exists only in types.
   */
  readonly [entryFactory]: TFactory
  /**
   * Whether the load waits for the query, and for which data. It exists only in types.
   */
  readonly [entryKind]: TKind
  /**
   * `null` when an `after` callback can start nothing. It exists only in types.
   */
  readonly [entryNull]: TNull
}

type AnyQueryHandleEntry = QueryHandleEntry<any, any, any>

type WaitedQueryHandleEntry = QueryHandleEntry<any, 'fetch' | 'ensure', any>

type EntryHandle<TEntry> =
  TEntry extends QueryHandleEntry<infer TFactory, any, infer TNull>
    ? QueryHandle<TFactory> | TNull
    : never

type EntryData<TEntry> =
  TEntry extends QueryHandleEntry<
    infer TFactory,
    'fetch' | 'ensure',
    infer TNull
  >
    ? InferQueryHandleData<TFactory> | TNull
    : never

type DependentEntry<TResult> = [Extract<TResult, AnyQueryHandleEntry>] extends [
  QueryHandleEntry<infer TFactory, infer TKind, infer TNull>,
]
  ? QueryHandleEntry<
      TFactory,
      TKind,
      TNull | (null extends TResult ? null : never)
    >
  : never

/**
 * What `experimental_loadQueryHandles` resolves to.
 */
export interface LoadedQueryHandles<
  TEntries extends Record<string, AnyQueryHandleEntry>,
> {
  /**
   * A handle for every entry, by the keys the callback returned. Return them from a loader.
   */
  handles: { [TKey in keyof TEntries]: EntryHandle<TEntries[TKey]> }
  /**
   * The data of every entry the load waited for, like `useSuspenseQuery`'s `data`.
   */
  data: {
    [
      TKey in keyof TEntries as TEntries[TKey] extends WaitedQueryHandleEntry
        ? TKey
        : never
    ]: EntryData<TEntries[TKey]>
  }
}

/**
 * Starts the queries of one `experimental_loadQueryHandles` call. It works only while a callback
 * of that call runs.
 */
export interface QueryHandleLoader {
  /**
   * Starts a query without waiting for it, like `queryClient.prefetchQuery`. It fetches only if
   * the cache has no fresh data. Its errors show up where a component reads it.
   */
  prefetch: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...args: QueryHandleLoadArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'prefetch'>
  /**
   * Starts a query and waits for fresh data, like `queryClient.fetchQuery`. It uses cached data
   * only if the factory's `staleTime` says it is fresh.
   */
  fetch: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...args: QueryHandleLoadArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'fetch'>
  /**
   * Uses cached data, even if stale, like `queryClient.ensureQueryData`. It fetches and waits
   * only when the cache has no data.
   */
  ensure: <TFactory extends QueryHandleFactory>(
    factory: TFactory,
    ...args: QueryHandleLoadArgs<TFactory>
  ) => QueryHandleEntry<TFactory, 'ensure'>
  /**
   * Starts a query that needs another query's data, as soon as that data is in the cache. Other
   * queries don't wait for it. Return `null` to start nothing.
   */
  after: <
    TParent extends WaitedQueryHandleEntry,
    TResult extends AnyQueryHandleEntry | null,
  >(
    parent: TParent,
    start: (data: EntryData<TParent>) => TResult,
  ) => DependentEntry<TResult>
}

// FUNCTIONS

/**
 * Tells `infiniteQueryOptions` results apart from `queryOptions` results.
 * @param options - Options a query factory returned.
 * @returns Whether they describe an infinite query.
 */
function isInfiniteOptions(options: QueryFactoryOptions): boolean {
  return 'initialPageParam' in options
}

/**
 * Starts a factory's query without waiting.
 * @param client - The client to start the query on.
 * @param options - Options a query factory returned.
 * @returns The promise of the query's data.
 */
function startQueryFromFactory(
  client: QueryClient,
  options: QueryFactoryOptions & { staleTime?: StaleTime },
): Promise<unknown> {
  return isInfiniteOptions(options)
    ? client.infiniteQuery(options as never)
    : client.query(options)
}

/**
 * Builds a handle.
 * @param options - Options a query factory returned.
 * @param input - The factory's input.
 * @returns A handle with their key and the input.
 */
function toHandle(options: QueryFactoryOptions, input: unknown) {
  return { queryKey: options.queryKey, input }
}

interface SettledEntry {
  handle: QueryHandle | null
  hasData: boolean
  data?: unknown
}

interface EntryState {
  promise: Promise<SettledEntry>
  waited: boolean
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
 * Starts a loader's queries together, waits for the ones it needs, and returns serializable
 * handles for all of them. A route loader, Server Component or server render passes the handles
 * to the components that read the queries.
 *
 * The callback starts every query before anything waits. It can't be async, and `load` throws
 * once it returns, so no query waits for another unless `load.after` says it needs that query's
 * data. Rejects as soon as a query it waits for fails or a callback throws, so a loader can
 * redirect or show an error page.
 * @param queryClient - The client to start the queries on.
 * @param callback - Starts the queries with `load` and returns them by name.
 * @returns A promise of the handles, and of the data of the queries it waited for.
 * @example
 * ```ts
 * // in a route loader
 * const { handles, data } = await experimental_loadQueryHandles(queryClient, (load) => ({
 *   // Uses a cached post, even a stale one, and waits only when there is none
 *   post: load.ensure(postQuery, { id: params.id }),
 *   // Doesn't wait
 *   comments: load.prefetch(commentsQuery, { postId: params.id }),
 * }))
 * if (!data.post) throw notFound()
 * return handles
 * ```
 */
export async function experimental_loadQueryHandles<
  TEntries extends Record<string, AnyQueryHandleEntry>,
>(
  queryClient: QueryClient,
  callback: (load: QueryHandleLoader) => TEntries,
): Promise<LoadedQueryHandles<TEntries>> {
  const states = new WeakMap<object, EntryState>()
  const waiting: Array<Promise<SettledEntry>> = []
  let open = false

  const run = <TResult>(start: () => TResult): TResult => {
    open = true
    try {
      const result = start()
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

  const addEntry = (promise: Promise<SettledEntry>, waited: boolean) => {
    promise.catch(noop)
    if (waited) waiting.push(promise)
    const entry = {}
    states.set(entry, { promise, waited })
    return entry as never
  }

  const startEntry =
    (kind: QueryHandleEntryKind) =>
    (
      factory: QueryHandleFactory,
      input?: unknown,
      loadOptions?: QueryHandleLoadOptions,
    ) => {
      if (!open) {
        throw new Error(
          'experimental_loadQueryHandles: start queries only while its callback runs, before anything waits.',
        )
      }
      const options = factory(input)
      const handle = toHandle(options, input) as QueryHandle
      const promise = startQueryFromFactory(queryClient, {
        ...options,
        ...(loadOptions?.pages !== undefined && { pages: loadOptions.pages }),
        ...(kind === 'ensure' && { staleTime: 'static' as const }),
      })
      if (kind === 'prefetch') {
        void promise.catch(noop)
        return addEntry(Promise.resolve({ handle, hasData: false }), false)
      }
      return addEntry(
        promise.then(() => {
          const { queryHash } = queryClient.defaultQueryOptions(options)
          const data = queryClient.getQueryCache().get(queryHash)?.state.data
          return {
            handle,
            hasData: true,
            data: options.select ? options.select(data) : data,
          }
        }),
        true,
      )
    }

  const load: QueryHandleLoader = {
    prefetch: startEntry('prefetch') as QueryHandleLoader['prefetch'],
    fetch: startEntry('fetch') as QueryHandleLoader['fetch'],
    ensure: startEntry('ensure') as QueryHandleLoader['ensure'],
    after: (parent, start) => {
      if (!open) {
        throw new Error(
          'experimental_loadQueryHandles: start queries only while its callback runs, before anything waits.',
        )
      }
      const parentState = states.get(parent)
      if (!parentState?.waited) {
        throw new Error(
          'experimental_loadQueryHandles: `load.after` takes a query from `load.fetch`, `load.ensure` or `load.after` of the same call.',
        )
      }
      return addEntry(
        parentState.promise.then((settled) => {
          const entry = run(() => start(settled.data as never))
          if (entry === null) return { handle: null, hasData: true, data: null }
          const state = states.get(entry)
          if (!state) {
            throw new Error(
              'experimental_loadQueryHandles: a `load.after` callback must return a query of the same call, or null.',
            )
          }
          return state.promise
        }),
        true,
      )
    },
  }

  const entries = Object.entries(run(() => callback(load))).map(
    ([key, entry]) => {
      const state = states.get(entry)
      if (!state) {
        throw new Error(
          `experimental_loadQueryHandles: "${key}" is not a query of this call.`,
        )
      }
      return [key, state] as const
    },
  )

  // `load.after` adds queries while others settle, so wait until no new ones appear
  for (let count = -1; count !== waiting.length;) {
    count = waiting.length
    await Promise.all(waiting)
  }

  const handles: Record<string, unknown> = {}
  const data: Record<string, unknown> = {}
  for (const [key, state] of entries) {
    const settled = await state.promise
    handles[key] = settled.handle
    if (settled.hasData) data[key] = settled.data
  }
  return { handles, data } as LoadedQueryHandles<TEntries>
}

/**
 * Builds the handle of a query whose input you only know during render, like an id in another
 * query's data or a search term. It doesn't start the query: the component that reads the handle
 * does, when it renders, which makes it a request waterfall. The name keeps that visible. Prefer
 * starting queries in a route loader or server component with `experimental_loadQueryHandles`.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param input - The input to pass to the factory, if it takes one.
 * @returns A handle with the query's key and input.
 * @example
 * ```tsx
 * function MorePosts(props: { post: experimental_QueryHandle<typeof postQuery> }) {
 *   const { data: post } = useSuspenseQuery(experimental_fromHandle(postQuery, props.post))
 *   const authorPosts = experimental_waterfallHandle(authorPostsQuery, {
 *     authorId: post.authorId,
 *   })
 *   const { data } = useQuery(experimental_fromHandle(authorPostsQuery, authorPosts))
 * }
 * ```
 */
export function experimental_waterfallHandle<
  TFactory extends QueryHandleFactory,
>(factory: TFactory, ...input: QueryHandleArgs<TFactory>): QueryHandle<TFactory>
/**
 * Switches a handle, like one a loader passed down, to a new input, like a search term the user
 * types, and returns the handle for that input. It doesn't start the query: the component that
 * reads the handle does, when it renders, which makes it a request waterfall. Inputs that belong
 * in the URL, like a page number, should go to the loader instead.
 *
 * While the new input maps to the handle's own query, it returns the handle as is, so the first
 * render reads what the loader started. That also keeps the old input when only fields outside the
 * key change, so put everything the `queryFn` reads in the key.
 * @param factory - The factory that started the handle's query.
 * @param handle - The handle to switch from.
 * @param switchInput - Returns the new input, given the handle's input.
 * @returns `handle` while the switched input maps to its query, otherwise a handle for the new
 * input.
 * @example
 * ```tsx
 * function Search(props: { results: experimental_QueryHandle<typeof searchQuery> }) {
 *   // Start from the loader's term, so the first render reads the query it started
 *   const [term, setTerm] = React.useState(props.results.input.term)
 *   const results = experimental_waterfallHandle(searchQuery, props.results, (input) => ({
 *     ...input,
 *     term,
 *   }))
 *   const { data } = useQuery({
 *     ...experimental_fromHandle(searchQuery, results),
 *     placeholderData: keepPreviousData,
 *   })
 * }
 * ```
 */
export function experimental_waterfallHandle<
  TFactory extends QueryHandleFactory,
>(
  factory: TFactory,
  handle: QueryHandle<TFactory>,
  switchInput: (
    input: QueryHandleInput<TFactory>,
  ) => QueryHandleInput<TFactory>,
): QueryHandle<TFactory>
export function experimental_waterfallHandle<
  TFactory extends QueryHandleFactory,
>(factory: TFactory, ...args: Array<any>): QueryHandle<TFactory> {
  const [inputOrHandle, switchInput] = args as [
    unknown,
    ((input: QueryHandleInput<TFactory>) => QueryHandleInput<TFactory>)?,
  ]
  if (typeof switchInput !== 'function') {
    return toHandle(
      factory(inputOrHandle),
      inputOrHandle,
    ) as QueryHandle<TFactory>
  }
  const previous = inputOrHandle as QueryHandle<TFactory>
  const input = switchInput(previous.input)
  const options = factory(input)
  if (
    hashQueryKeyByOptions(options.queryKey, options) ===
    hashQueryKeyByOptions(previous.queryKey as QueryKey, options)
  ) {
    return previous
  }
  return toHandle(options, input) as QueryHandle<TFactory>
}

/**
 * Rebuilds a query's options from its handle: the options its factory returns for the handle's
 * input. Pass them to `useQuery`, `useSuspenseQuery`, `useSuspenseInfiniteQuery` or any other API
 * that takes query options, and spread them to add read-site options like `select`. They share the
 * cache entry the handle's verb started. They add no `initialData`, so `useQuery` may return
 * undefined data, and `useSuspenseQuery` waits for the query's data.
 * @param factory - The factory that started the query.
 * @param handle - The handle the factory's verb returned.
 * @returns The query's options.
 * @example
 * ```tsx
 * function Post(props: { post: QueryHandle<typeof postQuery> }) {
 *   const { data } = useSuspenseQuery({
 *     ...experimental_fromHandle(postQuery, props.post),
 *     select: (post) => post.title,
 *   })
 * }
 * ```
 */
export function experimental_fromHandle<TFactory extends QueryHandleFactory>(
  factory: TFactory,
  handle: QueryHandle<NoInfer<TFactory>>,
): FromHandleOptions<TFactory> {
  return factory(handle.input) as FromHandleOptions<TFactory>
}
