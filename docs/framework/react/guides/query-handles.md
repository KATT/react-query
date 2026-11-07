---
id: query-handles
title: Query Handles (experimental)
---

> These APIs are experimental. Their names start with `experimental_`, and they can change in a minor release.

A route loader or Server Component knows which data a page needs before the page renders. Query handles let it start those queries early and pass small references to the components that read them, so the components don't repeat the query's options.

A handle is a plain object with the query's key and its input. It is serializable, so a loader or Server Component can return it.

## Query factories

Handles come from query factories: functions of one input (or none) that return `queryOptions` or `infiniteQueryOptions`.

[//]: # 'Factories'

```tsx
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'

export const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: () => fetchPost(input.id),
    staleTime: 60 * 1000,
  })

export const commentsQuery = (input: { postId: string }) =>
  infiniteQueryOptions({
    queryKey: ['comments', input.postId] as const,
    queryFn: ({ pageParam }) =>
      fetchComments({ postId: input.postId, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (_lastPage, allPages) => allPages.length + 1,
  })

export const authorPostsQuery = (input: { authorId: string }) =>
  infiniteQueryOptions({
    queryKey: ['posts', 'by-author', input.authorId] as const,
    queryFn: ({ pageParam }) =>
      fetchPostsByAuthor({ authorId: input.authorId, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (_lastPage, allPages) => allPages.length + 1,
  })
```

[//]: # 'Factories'

A handle's type comes from its factory's key. Declare keys with `as const`: two factories with the same input and data then still produce different handle types, and passing one factory's handle to another is a type error.

## Loading queries

`experimental_loadQueryHandles(queryClient, entries)` starts a loader's queries and returns a handle for each. Its entries come from three functions, named after the `QueryClient` methods they behave like:

| Entry                        | Behaves like      | Waits for                     |
| ---------------------------- | ----------------- | ----------------------------- |
| `experimental_prefetchEntry` | `prefetchQuery`   | nothing                       |
| `experimental_fetchEntry`    | `fetchQuery`      | fresh data                    |
| `experimental_ensureEntry`   | `ensureQueryData` | any data, even if it is stale |

Each takes the factory, then the factory's input. Creating an entry starts nothing: `experimental_loadQueryHandles` starts every entry at once, before it waits for any, so the order of the entries doesn't matter.

It resolves to a tuple, `[handles, data]`. `handles` has a plain `{ queryKey, input }` handle for every entry, under the entry's key; return them from the loader. `data` has the data of the fetch and ensure entries, as `useSuspenseQuery` would give it. Leave `data` out when the loader doesn't need it: `const [handles] = await …`.

[//]: # 'Loader'

```tsx
import {
  experimental_ensureEntry,
  experimental_loadQueryHandles,
  experimental_prefetchEntry,
} from '@tanstack/react-query'

export const Route = createFileRoute('/posts/$id')({
  loader: async ({ context: { queryClient }, params }) => {
    const [handles] = await experimental_loadQueryHandles(queryClient, {
      // Start the comments without waiting, and stream them in
      comments: experimental_prefetchEntry(commentsQuery, {
        postId: params.id,
      }),
      // The page can't render without the post, so wait for it,
      // unless the cache has it already
      post: experimental_ensureEntry(postQuery, { id: params.id }),
    })
    return handles
  },
  component: PostPage,
})

function PostPage() {
  const { post, comments } = Route.useLoaderData()
  return (
    <article>
      <Title post={post} />
      <Comments comments={comments} />
      <MorePosts post={post} />
    </article>
  )
}
```

[//]: # 'Loader'

`Title` is in [Reading handles](#reading-handles), `Comments` in [Infinite queries](#infinite-queries) and `MorePosts` in [Dependent queries](#dependent-queries).

Prefetch and fetch entries use the query's `staleTime` like `queryClient.query`: they start a fetch only when the cache has no fresh data.

A prefetch entry never makes the load reject: fetch errors show up where a component reads the handle. A fetch or ensure entry rejects the load as soon as its fetch fails, so a loader can redirect or show an error page.

At runtime, every handle is the same plain object. In types, the handles of fetch and ensure entries are `experimental_DefinedQueryHandle`s: when the load resolved, the cache had their data.

### Using cached data, even if stale

The loader above ensures the post. `experimental_ensureEntry` is the handle version of `queryClient.query` with `staleTime: 'static'`, which [replaces the deprecated `ensureQueryData`](./prefetching.md#using-query-to-prefetch). If the cache has data, even stale data, the entry doesn't fetch or wait. If not, it fetches once and waits:

[//]: # 'EnsureData'

```tsx
const [handles] = await experimental_loadQueryHandles(queryClient, {
  // If we have the post loaded already, we don't want to block on a refetch.
  // Otherwise wait for it, and throw if it fails
  post: experimental_ensureEntry(postQuery, { id: params.id }),
})
```

[//]: # 'EnsureData'

The loader doesn't refetch stale data. The component that reads the handle does: it uses the factory's `staleTime`, so it refetches stale data in the background when it mounts.

### Reading data in a loader

Sometimes the loader needs the data itself, for example to throw `notFound()` when a post doesn't exist. Read it from `data`, which has the fetch and ensure entries only, because a prefetched query may not have data yet:

[//]: # 'LoaderData'

```tsx
const [handles, data] = await experimental_loadQueryHandles(queryClient, {
  comments: experimental_prefetchEntry(commentsQuery, { postId: params.id }),
  post: experimental_ensureEntry(postQuery, { id: params.id }),
})
if (!data.post) {
  throw notFound()
}
return handles
```

[//]: # 'LoaderData'

The comments start with the post, and the loader doesn't wait for them. `data` has no `comments` key, so reading it is a type error. `data.post` is what the factory's `select` returns, or else the `queryFn`'s data.

> [!WARNING]
> Use the data for decisions in the loader, like throwing `notFound()` or redirecting. Don't build other queries' inputs from it unless they really need it: those queries wait for this one, which is a waterfall.

### Dependent queries

Some queries do need another query's data. To show more posts by the post's author, you need the post's `authorId`. Start that query in the component that reads the post, by passing its factory's options to the hook:

[//]: # 'DependentQuery'

```tsx
function MorePosts(props: {
  post: experimental_QueryHandle<typeof postQuery>
}) {
  const { data: post } = useSuspenseQuery(
    experimental_fromHandle(postQuery, props.post),
  )
  const { data } = useInfiniteQuery(
    authorPostsQuery({ authorId: post.authorId }),
  )
  return (
    <ul>
      {data?.pages.flat().map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  )
}
```

[//]: # 'DependentQuery'

The loader doesn't wait for the author's posts, so the page shows the post while they load. They can't start until the post's data arrives, which is a [request waterfall](./request-waterfalls.md). Most pages don't need this: put the input in the URL, or have the post's query return what the page needs, so the loader can start everything at once.

### Infinite queries

Entries take factories built with `infiniteQueryOptions` too, and start infinite queries. The loader above prefetches `commentsQuery`, and a component reads the handle with `useSuspenseInfiniteQuery` or `useInfiniteQuery`:

[//]: # 'InfiniteRead'

```tsx
function Comments(props: {
  comments: experimental_QueryHandle<typeof commentsQuery>
}) {
  const { data, fetchNextPage } = useSuspenseInfiniteQuery(
    experimental_fromHandle(commentsQuery, props.comments),
  )
  return <button onClick={() => fetchNextPage()}>{data.pages.length}</button>
}
```

[//]: # 'InfiniteRead'

With a fetch or ensure entry instead, `data.comments` is `InfiniteData`: `{ pages, pageParams }`. To load more than the first page, set `pages` in the factory.

### Pitfalls

**Awaiting one load after another.** Each load waits before the next one starts. Put queries that don't depend on each other in one load:

[//]: # 'SequentialLoads'

```tsx
// The comments start only after the post has loaded
const first = await experimental_loadQueryHandles(queryClient, {
  post: experimental_ensureEntry(postQuery, { id }),
})
const second = await experimental_loadQueryHandles(queryClient, {
  comments: experimental_prefetchEntry(commentsQuery, { postId: id }),
})

// Both start at once
const [handles] = await experimental_loadQueryHandles(queryClient, {
  comments: experimental_prefetchEntry(commentsQuery, { postId: id }),
  post: experimental_ensureEntry(postQuery, { id }),
})
```

[//]: # 'SequentialLoads'

**Building another query's input from loaded data.** See the warning in [Reading data in a loader](#reading-data-in-a-loader).

**Waiting for data the page can stream.** Every fetch and ensure entry holds the loader until its query has data. Use a prefetch entry for data the page can show later, and [stream it in](#streaming-pending-queries).

## Reading handles

`experimental_fromHandle(factory, handle)` rebuilds the query's options from its handle. Pass them to `useQuery`, `useSuspenseQuery`, `useSuspenseInfiniteQuery` or any other API that takes query options, and spread them to add read-site options like `select`:

[//]: # 'Reading'

```tsx
import {
  experimental_fromHandle,
  useSuspenseQuery,
  type experimental_QueryHandle,
} from '@tanstack/react-query'

function Title(props: { post: experimental_QueryHandle<typeof postQuery> }) {
  const { data: title } = useSuspenseQuery({
    ...experimental_fromHandle(postQuery, props.post),
    select: (post) => post.title,
  })
  return <h1>{title}</h1>
}
```

[//]: # 'Reading'

The factory types `select`'s argument, as with any `queryOptions` result. A `select` in the factory works too: readers get the selected type, and a read-site `select` replaces it. Keep options that decide how the query fetches or how long its data stays fresh, like `queryFn` or `staleTime`, on the factory, so the loader and the component agree on them.

Readers get the query's data from the cache. To get defined `data`, read the handle with `useSuspenseQuery`, which waits for the data. To type a prop that takes that data, use `experimental_InferQueryHandleData<typeof postQuery>`, which gives the same type as `useSuspenseQuery`'s `data`. `useQuery` types `data` as possibly `undefined`, as usual, even for a handle a loader waited for: the cache may have lost the data since, for example after `queryClient.clear()`.

## Queries without a handle

A factory builds the same key for the same input, so a component can call the factory itself and read the same cache entry a handle points to. Do that when the component only knows the input during render, like a term the user is typing. Use `experimental_fromHandle` to read a handle as it was passed in.

A search box can start from the term the loader searched for, like a `?q=` search param, and search again as the user types:

[//]: # 'SearchBox'

```tsx
const searchQuery = (input: { term: string }) =>
  infiniteQueryOptions({
    queryKey: ['search', input.term] as const,
    queryFn: ({ pageParam }) => search({ term: input.term, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (_lastPage, allPages) => allPages.length + 1,
  })

function SearchBox(props: {
  results: experimental_QueryHandle<typeof searchQuery>
}) {
  const [term, setTerm] = React.useState(props.results.input.term)
  const { data } = useInfiniteQuery({
    ...searchQuery({ term }),
    placeholderData: keepPreviousData,
  })
  return (
    <>
      <input value={term} onChange={(event) => setTerm(event.target.value)} />
      <ul>
        {data?.pages.flat().map((result) => (
          <li key={result.id}>{result.title}</li>
        ))}
      </ul>
    </>
  )
}
```

[//]: # 'SearchBox'

`term` starts from the handle's input, so the first render reads the query the loader started instead of searching again. `keepPreviousData` keeps the old results on screen while a new term loads. Page numbers and filters belong in the URL, so the loader can start them.

A query that a component starts during render is a [request waterfall](./request-waterfalls.md). It starts when its reader renders, like with any other query hook. `useQuery` and `useInfiniteQuery` don't fetch during a server render, while the suspense hooks do.

## Server rendering

Queries you start with handles work with the [hydration APIs](./advanced-ssr.md) like any other query.

### Streaming pending queries

`dehydrate` only includes successful queries by default. To stream a query that a prefetch entry started and that is still pending, opt in through `shouldDehydrateQuery`. A pending query dehydrates to a promise, so the page needs a transport that can send promises, like React Server Components, TanStack Start or React Router:

[//]: # 'DehydratePending'

```tsx
import { QueryClient, defaultShouldDehydrateQuery } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    dehydrate: {
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    },
  },
})
```

[//]: # 'DehydratePending'

### Server `staleTime`

Queries started on the server follow the same `staleTime` rules as in the browser. The data a server render sends along is as old as the server fetch, and when the browser reads it, a query with the default `staleTime: 0` already counts as stale. The component that reads it refetches on mount, so each request runs twice: once on the server and once in the browser.

[//]: # 'StaleTimeDoubleFetch'

```tsx
const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: () => fetchPost(input.id),
    // No staleTime: it defaults to 0
  })

// On the server: fetches the post, and sends it along with the page
const [handles] = await experimental_loadQueryHandles(queryClient, {
  post: experimental_ensureEntry(postQuery, { id }),
})

// In the browser: the post is already stale, so this fetches it again on mount
const { data } = useQuery(experimental_fromHandle(postQuery, handles.post))
```

[//]: # 'StaleTimeDoubleFetch'

The fix is a `staleTime` above 0, either on the factory or as a default of the `QueryClient`. Pick one that covers the time between the server fetch and the browser's first render:

[//]: # 'StaleTimeFix'

```tsx
const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: () => fetchPost(input.id),
    staleTime: 60 * 1000,
  })

// Or, for every query:
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000 } },
})
```

[//]: # 'StaleTimeFix'

Set `staleTime` on the factory rather than at the read site, so the server and the browser use the same value.

### Nested dehydration without sending a query twice

With Server Components, each component that starts queries can render its own `HydrationBoundary`. When two of them share a query, both dehydrate it, and the page sends its data twice. To send each query once per request, track the hashes of the queries you've already sent and skip them in `shouldDehydrateQuery`.

The tracker must belong to one request. Create it with the request's `QueryClient`, or with React's `cache()` in Server Components, which gives each request its own copy:

[//]: # 'NestedDehydrate'

```tsx
// app/get-query-client.ts
import { cache } from 'react'
import {
  QueryClient,
  defaultShouldDehydrateQuery,
  dehydrate,
} from '@tanstack/react-query'

export const getQueryClient = cache(
  () =>
    new QueryClient({ defaultOptions: { queries: { staleTime: 60 * 1000 } } }),
)

// One set per request, like the QueryClient
const getSentQueryHashes = cache(() => new Set<string>())

export function dehydrateUnsent() {
  const sent = getSentQueryHashes()
  return dehydrate(getQueryClient(), {
    shouldDehydrateQuery: (query) => {
      if (sent.has(query.queryHash)) return false
      const include =
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending'
      if (include) sent.add(query.queryHash)
      return include
    },
  })
}
```

[//]: # 'NestedDehydrate'

Outside Server Components, key the tracker by the request's client, for example with a `WeakMap<QueryClient, Set<string>>`, or create it next to the client in your request handler.

Don't create the tracker at module level:

[//]: # 'NestedDehydrateDont'

```tsx
// Don't do this: one set for every request the server handles
const sent = new Set<string>()

export function dehydrateUnsent(queryClient: QueryClient) {
  return dehydrate(queryClient, {
    shouldDehydrateQuery: (query) => {
      if (sent.has(query.queryHash)) return false
      sent.add(query.queryHash)
      return true
    },
  })
}
```

[//]: # 'NestedDehydrateDont'

Every request the server handles shares the module. Once one request has sent a query, every later request for any user skips it, so their pages arrive without its data and fetch it again in the browser. The set also grows for as long as the server runs.

Each query goes out once, with the state it has when `dehydrate` first includes it. If it changes later in the same request, the change doesn't reach the browser.
