import { hashQueryKeyByOptions, noop } from './utils'
import type { QueryClient } from './queryClient'
import type {
  InferDataFromTag,
  QueryKey,
  QueryKeyHashFunction,
  StaleTime,
} from './types'

// TYPES

/**
 * The options a query factory returns, usually from `queryOptions` or `infiniteQueryOptions`.
 */
interface QueryFactoryOptions {
  queryKey: QueryKey
  queryKeyHashFn?: QueryKeyHashFunction<any>
}

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

/**
 * A `staleTime` for a factory's query: a `StaleTime`, or what the factory's options take, like
 * `queryOptions`' function of the query.
 */
type FactoryStaleTime<TFactory extends QueryHandleFactory> =
  | StaleTime
  | ('staleTime' extends keyof ReturnType<TFactory>
      ? Exclude<ReturnType<TFactory>['staleTime'], undefined>
      : never)

/**
 * Options for one call of `experimental_queryHandle`. They
 * apply to that call only: the handle doesn't carry them, so readers use the factory's options.
 */
export interface QueryHandleCallOptions<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
> {
  /**
   * Decides whether this call fetches, instead of the factory's `staleTime`. With `'static'`, the
   * call uses any cached data, even if stale, and fetches only when the cache has none.
   */
  staleTime?: FactoryStaleTime<TFactory>
}

/**
 * The arguments the start functions take after the factory: its input, then options for the
 * call. A factory without input takes `undefined` in the input's place before the options.
 */
type QueryHandleStartArgs<TFactory extends QueryHandleFactory> =
  Parameters<TFactory> extends []
    ? [input?: undefined, callOptions?: QueryHandleCallOptions<TFactory>]
    : Parameters<TFactory> extends [infer TInput, ...Array<any>]
      ? [input: TInput, callOptions?: QueryHandleCallOptions<TFactory>]
      : [
          input?: Parameters<TFactory>[0],
          callOptions?: QueryHandleCallOptions<TFactory>,
        ]

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
 * A small serializable reference to a query, from `experimental_queryHandle` or
 * `experimental_waterfallHandle`. Pass
 * it to the component that reads the query, and rebuild the query's options there with
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

/**
 * What `experimental_queryHandle` returns. Pass `handle` to the component that reads the query.
 * Don't return the whole object from a loader: `promise` isn't serializable.
 */
export interface StartedQueryHandle<
  TFactory extends QueryHandleFactory = QueryHandleFactory,
> {
  /**
   * The query's handle.
   */
  handle: QueryHandle<TFactory>
  /**
   * Resolves with `handle` once the query has data, and rejects if the fetch fails.
   */
  promise: Promise<QueryHandle<TFactory>>
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
  options: QueryFactoryOptions,
): Promise<unknown> {
  return isInfiniteOptions(options)
    ? client.infiniteQuery(options as never)
    : client.query(options)
}

/**
 * Builds a factory's options for a start function's arguments.
 * @param factory - The query factory.
 * @param args - The factory's input, if any, then options for the call.
 * @returns The factory's options, with the call's `staleTime` over them if it has one.
 */
function startOptions(
  factory: QueryHandleFactory,
  args: Array<unknown>,
): QueryFactoryOptions & { staleTime?: unknown } {
  const options = args.length === 0 ? factory() : factory(args[0])
  const staleTime = (args[1] as QueryHandleCallOptions | undefined)?.staleTime
  return staleTime === undefined ? options : { ...options, staleTime }
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
 * Starts a query and returns its serializable handle, with a promise that settles when the query
 * does. A route loader, server component or server render passes the handle to the component that
 * reads the query. Like `queryClient.query`, it fetches only if the cache has no fresh data.
 *
 * The promise resolves with the same handle, and rejects if the fetch fails, so a loader can
 * redirect or show an error page. A promise you don't await never causes an unhandled rejection:
 * fetch errors then show up where a component reads the handle.
 * @param queryClient - The client to start the query on.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param args - The input to pass to the factory, if it takes one, then options for this call
 * only. With `{ staleTime: 'static' }`, it uses any cached data, even if stale, and fetches only
 * when the cache has none.
 * @returns The handle, and a promise of the handle once the query has data.
 * @example
 * ```ts
 * const postQuery = (input: { id: string }) =>
 *   queryOptions({
 *     queryKey: ['post', input.id] as const,
 *     queryFn: () => fetchPost(input.id),
 *   })
 *
 * // in a route loader
 * return {
 *   // wait for fresh data
 *   post: await experimental_queryHandle(queryClient, postQuery, { id }).promise,
 *   // don't wait
 *   comments: experimental_queryHandle(queryClient, commentsQuery, { id }).handle,
 * }
 * ```
 */
export function experimental_queryHandle<TFactory extends QueryHandleFactory>(
  queryClient: QueryClient,
  factory: TFactory,
  ...args: QueryHandleStartArgs<TFactory>
): StartedQueryHandle<TFactory> {
  const options = startOptions(factory, args)
  const handle = toHandle(options, args[0]) as QueryHandle<TFactory>
  const promise = startQueryFromFactory(queryClient, options).then(() => handle)
  promise.catch(noop)
  return { handle, promise }
}

/**
 * Builds the handle of a query whose input you only know during render, like a search term or a
 * page a user clicks to. It doesn't start the query: the component that reads the handle does,
 * when it renders, which makes it a request waterfall. The name keeps that visible. Prefer
 * starting queries in a route loader or server component with `experimental_queryHandle`.
 * @param factory - The query factory, a function of the query's input that returns its options.
 * @param input - The input to pass to the factory, if it takes one.
 * @returns A handle with the query's key and input.
 * @example
 * ```tsx
 * function Search(props: { term: string }) {
 *   const results = experimental_waterfallHandle(searchQuery, { term: props.term })
 *   const { data } = useQuery(experimental_fromHandle(searchQuery, results))
 * }
 * ```
 */
export function experimental_waterfallHandle<
  TFactory extends QueryHandleFactory,
>(factory: TFactory, ...input: QueryHandleArgs<TFactory>): QueryHandle<TFactory>
/**
 * Switches a handle, like one a loader passed down, to a new input, like the next page, and
 * returns the handle for that input. It doesn't start the query: the component that reads the
 * handle does, when it renders, which makes it a request waterfall. Prefer passing the new input
 * to the loader through the URL.
 *
 * While the new input maps to the handle's own query, it returns the handle as is, so the first
 * page reads what the loader started. That also keeps the old input when only fields outside the
 * key change, so put everything the `queryFn` reads in the key.
 * @param factory - The factory that started the handle's query.
 * @param handle - The handle to switch from.
 * @param switchInput - Returns the new input, given the handle's input.
 * @returns `handle` while the switched input maps to its query, otherwise a handle for the new
 * input.
 * @example
 * ```tsx
 * function Posts(props: { posts: experimental_QueryHandle<typeof postsQuery> }) {
 *   const [page, setPage] = React.useState(1)
 *   const posts = experimental_waterfallHandle(postsQuery, props.posts, (input) => ({
 *     ...input,
 *     page,
 *   }))
 *   const { data } = useQuery(experimental_fromHandle(postsQuery, posts))
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
