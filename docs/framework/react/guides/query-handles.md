---
id: query-handles
title: Query Handles (experimental)
---

> These APIs are experimental. Their names start with `experimental_`, and they can change in a minor release.

A route loader or Server Component knows which data a page needs before the page renders. Query handles let it start those queries early and pass small references to the components that read them, so the components don't repeat the query's options.

A handle is a plain object with the query's key and its input. It is serializable, so a loader or Server Component can return it.

## Query factories

Handles come from query factories: functions of one input (or none) that return query options.

[//]: # 'Factories'

```tsx
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'

export const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: () => fetchPost(input.id),
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
  queryOptions({
    queryKey: ['posts', 'by-author', input.authorId] as const,
    queryFn: () => fetchPostsByAuthor(input.authorId),
  })
```

[//]: # 'Factories'

A handle's type comes from its factory's key. Declare keys with `as const`: two factories with the same input and data then still produce different handle types, and passing one factory's handle to another is a type error.

## Loading queries

`experimental_loadQueryHandles` starts a loader's queries and returns their handles. It takes the `QueryClient` and a callback. The callback gets `load`, starts each query with it, and returns the queries by name:

[//]: # 'Loader'

```tsx
import { experimental_loadQueryHandles } from '@tanstack/react-query'

// The loader gets queryClient from createRouter({ routeTree, context: { queryClient } })
export const Route = createFileRoute('/posts/$id')({
  loader: async ({ context: { queryClient }, params }) => {
    const [handles, data] = await experimental_loadQueryHandles(
      queryClient,
      (load) => ({
        // Uses a cached post, even a stale one, and waits only when there is none
        post: load.ensure(postQuery, { id: params.id }),
        // Doesn't wait
        comments: load.prefetch(commentsQuery, { postId: params.id }),
      }),
    )
    if (!data.post) throw notFound()
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

`Title` and `Comments` read their handles, as [Reading handles](#reading-handles) shows. `MorePosts` needs the post's author, so it starts its own query, as [Waterfalls](#waterfalls-experimental_waterfallhandle) shows.

`load` has three ways to start a query. Each takes the factory, then the factory's input:

| Function        | Waits for                                    | Like              |
| --------------- | -------------------------------------------- | ----------------- |
| `load.prefetch` | nothing                                      | `prefetchQuery`   |
| `load.fetch`    | fresh data, by the factory's `staleTime`     | `fetchQuery`      |
| `load.ensure`   | any data, and fetches only if none is cached | `ensureQueryData` |

The names follow the `QueryClient` methods that [`queryClient.query` replaces](./prefetching.md#using-query-to-prefetch), and each one behaves like its namesake. `load.prefetch` and `load.fetch` fetch only when the cache has no fresh data, by the query's `staleTime`. `load.prefetch` doesn't wait and doesn't reject: fetch errors show up where a component reads the handle. Use `load.fetch` when the page must not render stale data.

Every query starts before anything waits. The callback can't be async, and `load` throws once the callback returns, so you can't start a query after an `await`. The promise resolves when every query the load waits for has data, and rejects as soon as one of them fails, so a loader can redirect or show an error page.

It resolves to a pair, `[handles, data]`, so you name both parts:

- `handles`: a handle for every query, by name. Return them from the loader, or pass them as props.
- `data`: the data of every query from `load.fetch` and `load.ensure`, by name, like `useSuspenseQuery`'s `data`. Queries from `load.prefetch` have no data yet, so `data` leaves them out.

### Not found and redirects

Use `data` to decide what the loader does, like the loader above, which throws `notFound()` when the post doesn't exist. The comments started together with the post, so checking the post doesn't hold them back.

### Using cached data, even if stale

`load.ensure` works like `ensureQueryData`, or `queryClient.query` with `staleTime: 'static'`. If the cache has data, even stale data, it resolves at once without fetching. If not, it fetches once and waits. The loader above ensures the post:

[//]: # 'EnsureData'

```tsx
// If we have the post loaded already, we don't want to block on a refetch.
// Otherwise wait for it, and throw if it fails
post: load.ensure(postQuery, { id: params.id }),
```

[//]: # 'EnsureData'

The loader doesn't refetch stale data. The component that reads the handle does: it uses the factory's `staleTime`, so it refetches stale data in the background when it mounts.

### Infinite queries

Infinite factories work like the others. The loader above prefetches the first page of comments without waiting. To fetch more than the first page, pass `pages` after the input:

[//]: # 'Infinite'

```tsx
comments: load.prefetch(commentsQuery, { postId: params.id }, { pages: 2 }),
```

[//]: # 'Infinite'

`pages` is the number of pages the load fetches, starting from the first, like the `pages` option of `queryClient.infiniteQuery`. It stays out of the factory, so readers don't get it: when they refetch, they fetch every page they have. With `load.fetch` or `load.ensure`, the comments' `data` is `InfiniteData`, with `pages` and `pageParams`.

### Queries that need another query's data

"More by this author" needs the post's author, so its query can't start until the post's data arrives. By default, start it in the component that has the post, like `MorePosts` in [Waterfalls](#waterfalls-experimental_waterfallhandle). That keeps the loader short, and the page renders without waiting for it.

To start it in the loader instead, use `load.after`. It starts the dependent query as soon as the post's data is in the cache, before the page renders:

[//]: # 'After'

```tsx
;(load) => {
  const post = load.ensure(postQuery, { id: params.id })
  return {
    post,
    comments: load.prefetch(commentsQuery, { postId: params.id }),
    authorPosts: load.after(post, (post) =>
      post
        ? load.prefetch(authorPostsQuery, { authorId: post.authorId })
        : null,
    ),
  }
}
```

[//]: # 'After'

`load.after` takes a query from `load.fetch`, `load.ensure` or another `load.after`, and a callback that gets its data and starts the dependent query with `load`. Return `null` to start nothing; the handle is then `null`. The comments don't wait for the post, and the author's posts don't wait for the comments. The load waits for the post, and for the author's posts only if the callback used `load.fetch` or `load.ensure`. To end the load early, throw from the callback: `if (!post) throw notFound()`.

### Pitfalls

**Awaiting before the load.** Anything you await before `experimental_loadQueryHandles` holds back every query in it:

[//]: # 'AwaitBefore'

```tsx
// Every query in the load waits for the session
const session = await getSession()
const [handles] = await experimental_loadQueryHandles(queryClient, (load) => ({
  comments: load.prefetch(commentsQuery, { postId: params.id }),
}))
```

[//]: # 'AwaitBefore'

Make it a query and start it in the same load, or start the load and the other promise together and await both. For named results, define a small `allKeyed`. It mirrors [`Promise.allKeyed`](https://github.com/tc39/proposal-await-dictionary), a Stage 3 TC39 proposal, without patching `Promise`:

[//]: # 'PromiseAllKeyed'

```tsx
async function allKeyed<T extends Record<string, unknown>>(
  record: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(record)
  const values = await Promise.all(keys.map((key) => record[key]))
  return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as any
}

const { session, loaded } = await allKeyed({
  session: getSession(),
  loaded: experimental_loadQueryHandles(queryClient, (load) => ({
    comments: load.prefetch(commentsQuery, { postId: params.id }),
  })),
})
```

[//]: # 'PromiseAllKeyed'

**Two loads in a row.** The second load starts only when the first resolves. Put the queries in one load. Start the ones that need another query's data in a component, or with `load.after`.

**`load.after` when you already have the input.** The input of the author's posts is in the post's data, so `load.after` is right there. The post's comments only need the post's id, which the loader already has in `params`. Start them with `load.prefetch(commentsQuery, { postId: params.id })`, not inside `load.after`, or they wait for the post for nothing.

**Prefetched queries in `load.after`.** A dependent query's handle needs its parent's data, so the load waits for the parent even when the callback uses `load.prefetch`.

## Reading handles

`experimental_fromHandle(factory, handle)` rebuilds the query's options from its handle. Pass them to `useQuery`, `useSuspenseQuery`, `useSuspenseInfiniteQuery` or any other API that takes query options, and spread them to add read-site options like `select`:

[//]: # 'Reading'

```tsx
import {
  experimental_fromHandle,
  useSuspenseInfiniteQuery,
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

// An infinite factory's handle reads with the infinite hooks
function Comments(props: {
  comments: experimental_QueryHandle<typeof commentsQuery>
}) {
  const { data, fetchNextPage } = useSuspenseInfiniteQuery(
    experimental_fromHandle(commentsQuery, props.comments),
  )
  return <button onClick={() => fetchNextPage()}>{data.pages.length}</button>
}
```

[//]: # 'Reading'

The factory types `select`'s argument, as with any `queryOptions` result. A `select` in the factory works too: readers get the selected type, and a read-site `select` replaces it. Keep options that decide how the query fetches or how long its data stays fresh, like `queryFn` or `staleTime`, on the factory, so the loader and the component agree on them.

Readers get the query's data from the cache. To get defined `data`, read the handle with `useSuspenseQuery`, which waits for the data. To type a prop that takes that data, use `experimental_InferQueryHandleData<typeof postQuery>`, which gives the same type as `useSuspenseQuery`'s `data`. `useQuery` types `data` as possibly `undefined`, as usual, even for a query the load waited for: the cache may have lost the data since, for example after `queryClient.clear()`.

## Waterfalls: `experimental_waterfallHandle`

Sometimes you only know the input during render, like an id in another query's data or a search term the user types. `experimental_waterfallHandle` builds the handle for such an input. It doesn't start the query: the component that reads the handle does, when it renders. That makes it a [request waterfall](./request-waterfalls.md), and the name keeps that visible. It is a plain function, not a hook, so you can call it anywhere.

"More by this author" needs the post's author, so it can't start until the post's data arrives. Start it in the component that has the post:

[//]: # 'WaterfallDependent'

```tsx
function MorePosts(props: {
  post: experimental_QueryHandle<typeof postQuery>
}) {
  const { data: post } = useSuspenseQuery(
    experimental_fromHandle(postQuery, props.post),
  )
  const authorPosts = experimental_waterfallHandle(authorPostsQuery, {
    authorId: post.authorId,
  })
  const { data } = useQuery(
    experimental_fromHandle(authorPostsQuery, authorPosts),
  )
  return (
    <ul>
      {data?.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  )
}
```

[//]: # 'WaterfallDependent'

To start it before the page renders, use [`load.after`](#queries-that-need-another-querys-data) in the loader. Or have the post's query return what the page needs, so the loader can start everything at once.

You can also switch a handle a loader passed down to a new input. A search page's loader starts the results for the term in the URL, and the search box then fetches results as the user types:

[//]: # 'WaterfallSwitch'

```tsx
function SearchBox(props: {
  results: experimental_QueryHandle<typeof searchQuery>
}) {
  const [term, setTerm] = React.useState(props.results.input.term)
  const results = experimental_waterfallHandle(
    searchQuery,
    props.results,
    (input) => ({ ...input, term }),
  )
  const { data } = useQuery({
    ...experimental_fromHandle(searchQuery, results),
    placeholderData: keepPreviousData,
  })
  return <input value={term} onChange={(e) => setTerm(e.target.value)} />
}
```

[//]: # 'WaterfallSwitch'

`term` starts from the handle's input, so the first render reads the query the loader started instead of fetching again. While the switched input maps to the handle's own query, it returns that handle as is. That also keeps the old input when only fields outside the key change, so put everything the `queryFn` reads in the key. Keep state that belongs in the URL, like a page number, in the URL, so the loader can start it.

The query starts when its reader renders, like any other `useQuery` or `useSuspenseQuery`. `useQuery` doesn't fetch during a server render, while `useSuspenseQuery` does.

## Server rendering

Queries you start with handles work with the [hydration APIs](./advanced-ssr.md) like any other query.

### Streaming pending queries

`dehydrate` only includes successful queries by default. To stream a query that `load.prefetch` started and that is still pending, opt in through `shouldDehydrateQuery`. A pending query dehydrates to a promise, so the page needs a transport that can send promises, like React Server Components, TanStack Start or React Router:

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

A Server Component can then ensure the post and stream the comments:

[//]: # 'StreamingPage'

```tsx
// app/posts/[id]/page.tsx
export default async function PostPage({ params }) {
  const queryClient = getQueryClient()
  const [handles, data] = await experimental_loadQueryHandles(
    queryClient,
    (load) => ({
      post: load.ensure(postQuery, { id: params.id }),
      comments: load.prefetch(commentsQuery, { postId: params.id }),
    }),
  )
  if (!data.post) notFound()

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <Title post={handles.post} />
      <Suspense fallback={<Spinner />}>
        <Comments comments={handles.comments} />
      </Suspense>
    </HydrationBoundary>
  )
}

// app/posts/[id]/comments.tsx
;('use client')

export function Comments(props: {
  comments: experimental_QueryHandle<typeof commentsQuery>
}) {
  const { data, fetchNextPage } = useSuspenseInfiniteQuery(
    experimental_fromHandle(commentsQuery, props.comments),
  )
  return <button onClick={() => fetchNextPage()}>{data.pages.length}</button>
}
```

[//]: # 'StreamingPage'

The post arrives with the page. The comments arrive when their query finishes, and the browser doesn't fetch them again.

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
const [handles] = await experimental_loadQueryHandles(queryClient, (load) => ({
  post: load.ensure(postQuery, { id }),
}))

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
