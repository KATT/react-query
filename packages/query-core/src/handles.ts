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
 * `experimental_waterfallHandle`. Pass it to the component that reads the query, and rebuild the query's options there with
 * `experimental_fromHandle(factory, handle)`. It carries no data: readers get the query's data
 * from the cache.
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

declare const definedQueryHandle: unique symbol

/**
 * A handle from an `experimental_fetchEntry` or `experimental_ensureEntry` entry: when
 * `experimental_loadQueryHandles` resolved, the cache had the query's data. The brand exists only
 * in types, so the handle is still a plain `{ queryKey, input }`.
 */
export interface DefinedQueryHandle<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
> extends QueryHandle<TFactory> {
  /**
   * Marks a handle whose data was in the cache when it resolved. It exists only in types.
   */
  readonly [definedQueryHandle]: true
}

/**
 * How `experimental_loadQueryHandles` starts an entry's query, named after the `QueryClient`
 * method it behaves like.
 */
type QueryHandleEntryKind = 'prefetch' | 'fetch' | 'ensure'

/**
 * A query for `experimental_loadQueryHandles` to start, from `experimental_prefetchEntry`,
 * `experimental_fetchEntry` or `experimental_ensureEntry`. Creating it starts nothing.
 */
export interface QueryHandleEntry<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
  TKind extends QueryHandleEntryKind = QueryHandleEntryKind,
> {
  /**
   * The query factory, a function of the query's input that returns its options.
   */
  readonly factory: TFactory
  /**
   * The factory's input.
   */
  readonly input: QueryHandleInput<TFactory>
  /**
   * How to start the query, and whether to wait for it.
   */
  readonly kind: TKind
}

type HandleOfEntry<TEntry> =
  TEntry extends QueryHandleEntry<infer TFactory, infer TKind>
    ? TKind extends 'prefetch'
      ? QueryHandle<TFactory>
      : DefinedQueryHandle<TFactory>
    : never

type LoadedHandles<
  TEntries extends Record<string, QueryHandleEntry<any, any>>,
> = { [TKey in keyof TEntries]: HandleOfEntry<TEntries[TKey]> }

type LoadedData<TEntries extends Record<string, QueryHandleEntry<any, any>>> = {
  [
    TKey in keyof TEntries as TEntries[TKey] extends QueryHandleEntry<
      any,
      'fetch' | 'ensure'
    >
      ? TKey
      : never
  ]: InferQueryHandleData<TEntries[TKey]['factory']>
}

/**
 * What `experimental_loadQueryHandles` resolves to: `[handles, data]`. `handles` has a handle for
 * every entry, by the entry's key; return them from the loader. `data` has the data of every fetch
 * and ensure entry, by the entry's key, like `useSuspenseQuery`'s `data`.
 */
export type LoadedQueryHandles<
  TEntries extends Record<string, QueryHandleEntry<any, any>>,
> = readonly [handles: LoadedHandles<TEntries>, data: LoadedData<TEntries>]

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
 * function Byline(props: { post: experimental_InferQueryHandleData<typeof postQuery> }) {
 *   return <span>{props.post.author}</span>
 * }
 * ```
 */
export type InferQueryHandleData<
  T extends QueryHandleFactory | QueryHandle<any>,
> = T extends QueryHandleFactory
  ? FactoryData<ReturnType<T>>
  : T extends DefinedQueryHandle<infer TFactory>
    ? FactoryData<ReturnType<TFactory>>
    : T extends QueryHandle<infer TFactory>
      ? FactoryData<ReturnType<TFactory>>
      : never

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

/**
 * Reads a query's data from the cache, the way its readers get it.
 * @param client - The client that has the query's data.
 * @param options - Options a query factory returned.
 * @returns What the factory's `select` returns, or else the cached data.
 */
function readData(client: QueryClient, options: QueryFactoryOptions): unknown {
  const { queryHash } = client.defaultQueryOptions(options)
  const data = client.getQueryCache().get(queryHash)?.state.data
  return options.select ? options.select(data) : data
}

/**
 * Builds an entry for `experimental_loadQueryHandles` that starts the query without waiting for
 * it, like `queryClient.prefetchQuery`. It fetches only if the cache has no fresh data. Its
 * handle never makes the load reject: fetch errors show up where a component reads the handle.
 * Creating the entry starts nothing.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param input - The input to pass to the factory, if it takes one.
 * @returns An entry that starts the query without waiting.
 */
export function experimental_prefetchEntry<TFactory extends QueryHandleFactory>(
  factory: TFactory,
  ...input: QueryHandleArgs<TFactory>
): QueryHandleEntry<TFactory, 'prefetch'> {
  return {
    factory,
    input: input[0] as QueryHandleInput<TFactory>,
    kind: 'prefetch',
  }
}

/**
 * Builds an entry for `experimental_loadQueryHandles` that waits for fresh data, like
 * `queryClient.fetchQuery`: it uses cached data only if it isn't stale by the factory's
 * `staleTime`. The load rejects if the fetch fails. Creating the entry starts nothing.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param input - The input to pass to the factory, if it takes one.
 * @returns An entry that waits for fresh data.
 */
export function experimental_fetchEntry<TFactory extends QueryHandleFactory>(
  factory: TFactory,
  ...input: QueryHandleArgs<TFactory>
): QueryHandleEntry<TFactory, 'fetch'> {
  return {
    factory,
    input: input[0] as QueryHandleInput<TFactory>,
    kind: 'fetch',
  }
}

/**
 * Builds an entry for `experimental_loadQueryHandles` that uses any cached data, even stale data,
 * like `queryClient.ensureQueryData`. It fetches and waits only when the cache has no data, and
 * the load rejects if that fetch fails. Readers use the factory's `staleTime`, so a reader
 * refetches stale data in the background when it mounts. Creating the entry starts nothing.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param input - The input to pass to the factory, if it takes one.
 * @returns An entry that waits for any cached data.
 */
export function experimental_ensureEntry<TFactory extends QueryHandleFactory>(
  factory: TFactory,
  ...input: QueryHandleArgs<TFactory>
): QueryHandleEntry<TFactory, 'ensure'> {
  return {
    factory,
    input: input[0] as QueryHandleInput<TFactory>,
    kind: 'ensure',
  }
}

/**
 * Starts a loader's queries at once and returns a serializable handle for each. A route loader,
 * server component or server render passes the handles to the components that read the queries.
 *
 * It starts every entry before it waits for any. It resolves when every fetch and ensure entry
 * has data, with the tuple `[handles, data]`: a handle for every entry, and the data of the fetch
 * and ensure entries. It rejects as soon as one of them fails, so a loader can redirect or show an
 * error page. Prefetch entries never make it reject.
 * @param queryClient - The client to start the queries on.
 * @param entries - The entries, by the key the loader returns their handles under.
 * @returns A promise of `[handles, data]`: the handles, and the data of the fetch and ensure
 * entries.
 * @example
 * ```ts
 * // in a route loader
 * const [handles, data] = await experimental_loadQueryHandles(queryClient, {
 *   comments: experimental_prefetchEntry(commentsQuery, { postId: id }),
 *   post: experimental_ensureEntry(postQuery, { id }),
 * })
 * if (!data.post) throw notFound()
 * return handles
 * ```
 */
export async function experimental_loadQueryHandles<
  TEntries extends Record<string, QueryHandleEntry<any, any>>,
>(
  queryClient: QueryClient,
  entries: TEntries,
): Promise<LoadedQueryHandles<TEntries>> {
  const loads = Object.entries(entries).map(([key, entry]) => {
    const options = entry.factory(entry.input)
    const promise = startQueryFromFactory(
      queryClient,
      entry.kind === 'ensure' ? { ...options, staleTime: 'static' } : options,
    )
    promise.catch(noop)
    return {
      key,
      options,
      handle: toHandle(options, entry.input),
      promise: entry.kind === 'prefetch' ? undefined : promise,
    }
  })
  await Promise.all(loads.map((load) => load.promise))

  const handles: Record<string, unknown> = {}
  const data: Record<string, unknown> = {}
  for (const load of loads) {
    handles[load.key] = load.handle
    if (load.promise) data[load.key] = readData(queryClient, load.options)
  }
  return [handles, data] as unknown as LoadedQueryHandles<TEntries>
}

/**
 * Builds the handle of a query whose input you only know during render, like an id in another
 * query's data. It doesn't start the query: the component that reads the handle does, when it
 * renders, which makes it a request waterfall. The name keeps that visible. Prefer starting
 * queries in a route loader or server component with `experimental_loadQueryHandles`.
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
 * Switches a handle, like one a loader passed down, to a new input, like a term the user is
 * typing, and returns the handle for that input. It doesn't start the query: the component that
 * reads the handle does, when it renders, which makes it a request waterfall. Put input that
 * doesn't change on every keystroke, like page numbers and filters, in the URL, so the loader can
 * start it.
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
 *   return <input value={term} onChange={(event) => setTerm(event.target.value)} />
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
 * cache entry that `experimental_loadQueryHandles` started. They add no `initialData`, so `useQuery` may return
 * undefined data, and `useSuspenseQuery` waits for the query's data.
 * @param factory - The factory that started the query.
 * @param handle - A handle of the factory's query.
 * @returns The query's options.
 * @example
 * ```tsx
 * function Title(props: { post: experimental_QueryHandle<typeof postQuery> }) {
 *   const { data: title } = useSuspenseQuery({
 *     ...experimental_fromHandle(postQuery, props.post),
 *     select: (post) => post.title,
 *   })
 *   return <h1>{title}</h1>
 * }
 * ```
 */
export function experimental_fromHandle<TFactory extends QueryHandleFactory>(
  factory: TFactory,
  handle: QueryHandle<NoInfer<TFactory>>,
): FromHandleOptions<TFactory> {
  return factory(handle.input) as FromHandleOptions<TFactory>
}
