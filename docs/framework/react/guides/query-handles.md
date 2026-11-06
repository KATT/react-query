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
    staleTime: 60 * 1000,
  })

export const viewerQuery = () =>
  queryOptions({
    queryKey: ['viewer'] as const,
    queryFn: fetchViewer,
  })

export const authorPostsQuery = (input: { authorId: string }) =>
  queryOptions({
    queryKey: ['posts', 'by-author', input.authorId] as const,
    queryFn: () => fetchAuthorPosts(input.authorId),
  })

export const commentsQuery = (input: { postId: string }) =>
  infiniteQueryOptions({
    queryKey: ['comments', input.postId] as const,
    queryFn: ({ pageParam }) => fetchComments(input.postId, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
  })
```

[//]: # 'Factories'

A handle's type comes from its factory's key. Declare keys with `as const`: two factories with the same input and data then still produce different handle types, and passing one factory's handle to another is a type error.

## Loading queries

`experimental_loadQueryHandles` starts a loader's queries and returns their handles. It takes the `QueryClient` and a callback. The callback gets `load`, starts each query with it, and returns the queries by name:

[//]: # 'Loader'

```tsx
import { experimental_loadQueryHandles } from '@tanstack/react-query'

export const Route = createFileRoute('/posts/$id')({
  loader: async ({ context: { queryClient }, params }) => {
    const { handles } = await experimental_loadQueryHandles(
      queryClient,
      (load) => ({
        // The page can't render without the post, so wait for it
        post: load.wait(postQuery, { id: params.id }),
        // Start the viewer without waiting, and stream it in
        viewer: load.start(viewerQuery),
      }),
    )
    return handles
  },
})
```

[//]: # 'Loader'

`load` has three ways to start a query. Each takes the factory, then the factory's input:

| Function      | Waits for                     |
| ------------- | ----------------------------- |
| `load.start`  | nothing                       |
| `load.wait`   | fresh data                    |
| `load.ensure` | any data, even if it is stale |

`load.start` and `load.wait` use the query's `staleTime` like `queryClient.query`: they fetch only when the cache has no fresh data. `load.start` doesn't wait and doesn't reject: fetch errors show up where a component reads the handle.

Every query starts before anything waits. The callback can't be async, and `load` throws once the callback returns, so you can't start a query after an `await`. The promise resolves when every query the load waits for has data, and rejects as soon as one of them fails, so a loader can redirect or show an error page.

It resolves to two objects:

- `handles`: a handle for every query, by name. Return them from the loader, or pass them as props.
- `data`: the data of every query from `load.wait` and `load.ensure`, by name, like `useSuspenseQuery`'s `data`. Queries from `load.start` have no data yet, so `data` leaves them out.

### Not found and redirects

Use `data` to decide what the loader does, like throwing `notFound()` when a post doesn't exist:

[//]: # 'NotFound'

```tsx
loader: async ({ context: { queryClient }, params }) => {
  const { handles, data } = await experimental_loadQueryHandles(
    queryClient,
    (load) => ({
      post: load.wait(postQuery, { id: params.id }),
      viewer: load.start(viewerQuery),
    }),
  )
  if (!data.post) throw notFound()
  return handles
}
```

[//]: # 'NotFound'

The viewer started together with the post, so checking the post doesn't hold it back.

### Using cached data, even if stale

`load.ensure` is the handle version of `queryClient.query` with `staleTime: 'static'`, which [replaces the deprecated `ensureQueryData`](./prefetching.md#using-query-to-prefetch). If the cache has data, even stale data, it resolves at once without fetching. If not, it fetches once and waits:

[//]: # 'EnsureData'

```tsx
const { handles } = await experimental_loadQueryHandles(
  queryClient,
  (load) => ({
    // If we have the post loaded already, we don't want to block on a refetch.
    // Otherwise wait for it, and throw if it fails
    post: load.ensure(postQuery, { id: params.id }),
  }),
)
```

[//]: # 'EnsureData'

The loader doesn't refetch stale data. The component that reads the handle does: it uses the factory's `staleTime`, so it refetches stale data in the background when it mounts.

### Queries that need another query's data

Sometimes a query's input comes from another query's data. The page shows more posts by the post's author, and only the post knows the author. `load.after` starts such a query as soon as the other query's data is in the cache:

[//]: # 'After'

```tsx
const { handles, data } = await experimental_loadQueryHandles(
  queryClient,
  (load) => {
    const post = load.wait(postQuery, { id: params.id })
    return {
      post,
      viewer: load.start(viewerQuery),
      morePosts: load.after(post, (post) =>
        post ? load.start(authorPostsQuery, { authorId: post.authorId }) : null,
      ),
    }
  },
)
if (!data.post) throw notFound()
return handles
```

[//]: # 'After'

`load.after` takes a query from `load.wait`, `load.ensure` or another `load.after`, and a callback that gets its data and starts the dependent query with `load`. Return `null` to start nothing; the handle is then `null`. The viewer doesn't wait for the post, and the author's posts don't wait for the viewer. The load waits for the post, and for the author's posts only if the callback used `load.wait` or `load.ensure`.

To end the load early, throw from the callback: `if (!post) throw notFound()`. The load rejects at once, without waiting for its other queries.

### Infinite queries

Infinite factories work like the others. Their `data` is `InfiniteData`, with `pages` and `pageParams`. To fetch more than the first page, pass `pages` after the input:

[//]: # 'Infinite'

```tsx
const { handles, data } = await experimental_loadQueryHandles(
  queryClient,
  (load) => ({
    post: load.wait(postQuery, { id: params.id }),
    comments: load.wait(commentsQuery, { postId: params.id }, { pages: 2 }),
  }),
)
data.comments.pages // the first two pages
```

[//]: # 'Infinite'

`pages` is the number of pages the load fetches, starting from the first, like the `pages` option of `queryClient.infiniteQuery`. It stays out of the factory, so readers don't get it: when they refetch, they fetch every page they have.

### Pitfalls

**Awaiting before the load.** Anything you await before `experimental_loadQueryHandles` holds back every query in it:

[//]: # 'AwaitBefore'

```tsx
// Every query in the load waits for the session
const session = await getSession()
const { handles } = await experimental_loadQueryHandles(
  queryClient,
  (load) => ({
    viewer: load.start(viewerQuery),
  }),
)
```

[//]: # 'AwaitBefore'

Make it a query and start it in the same load, or start the load first and await both with `Promise.all`.

**Two loads in a row.** The second load starts only when the first resolves. Put the queries in one load, and use `load.after` for the ones that need another query's data.

**`load.after` when you already have the input.** The input of the author's posts is in the post's data, so `load.after` is right there. The post's comments only need the post's id, which the loader already has in `params`. Start them with `load.start(commentsQuery, { postId: params.id })`, not inside `load.after`, or they wait for the post for nothing.

**Started queries after `load.after`.** A dependent query's handle needs its parent's data, so the load waits for the parent even when the callback uses `load.start`.

## Reading handles

`experimental_fromHandle(factory, handle)` rebuilds the query's options from its handle. Pass them to `useQuery`, `useSuspenseQuery`, `useSuspenseInfiniteQuery` or any other API that takes query options, and spread them to add read-site options like `select`:

[//]: # 'Reading'

```tsx
import {
  experimental_fromHandle,
  useSuspenseQuery,
  type experimental_QueryHandle,
} from '@tanstack/react-query'

function Post(props: { post: experimental_QueryHandle<typeof postQuery> }) {
  const { data } = useSuspenseQuery({
    ...experimental_fromHandle(postQuery, props.post),
    select: (post) => post.title,
  })
  return <h1>{data}</h1>
}
```

[//]: # 'Reading'

The factory types `select`'s argument, as with any `queryOptions` result. A `select` in the factory works too: readers get the selected type, and a read-site `select` replaces it. Keep options that decide how the query fetches or how long its data stays fresh, like `queryFn` or `staleTime`, on the factory, so the loader and the component agree on them.

Readers get the query's data from the cache. To get defined `data`, read the handle with `useSuspenseQuery`, which waits for the data. To type a prop that takes that data, use `experimental_InferQueryHandleData<typeof postQuery>`, which gives the same type as `useSuspenseQuery`'s `data`. `useQuery` types `data` as possibly `undefined`, as usual, even for a query the load waited for: the cache may have lost the data since, for example after `queryClient.clear()`.

## Waterfalls: `experimental_waterfallHandle`

Sometimes you only know the input during render, like a search term, a page a user clicks to, or an id in another query's data. `experimental_waterfallHandle` builds the handle for such an input. It doesn't start the query: the component that reads the handle does, when it renders. That makes it a [request waterfall](./request-waterfalls.md), and the name keeps that visible. It is a plain function, not a hook, so you can call it anywhere.

Pass it an input:

[//]: # 'WaterfallInput'

```tsx
function Search(props: { term: string }) {
  const results = experimental_waterfallHandle(searchQuery, {
    term: props.term,
  })
  const { data } = useQuery(experimental_fromHandle(searchQuery, results))
}
```

[//]: # 'WaterfallInput'

When the input comes from another query's data and the loader didn't start that query, start the dependent query in the component that has the data. If the loader starts both, use [`load.after`](#queries-that-need-another-querys-data) instead, so the dependent query starts before the page renders:

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
}
```

[//]: # 'WaterfallDependent'

Most pages don't need this. Put the input in the URL, or have the post's query return what the page needs, so the loader can start everything at once.

Or switch a handle a loader passed down to a new input:

[//]: # 'WaterfallSwitch'

```tsx
function Posts(props: { posts: experimental_QueryHandle<typeof postsQuery> }) {
  const [page, setPage] = React.useState(props.posts.input.page)
  const posts = experimental_waterfallHandle(
    postsQuery,
    props.posts,
    (input) => ({
      ...input,
      page,
    }),
  )
  const { data } = useQuery({
    ...experimental_fromHandle(postsQuery, posts),
    placeholderData: keepPreviousData,
  })
}
```

[//]: # 'WaterfallSwitch'

`page` starts from the handle's input, so the first render reads the query the loader started instead of fetching another page. While the switched input maps to the handle's own query, it returns that handle as is, so the first page reads what the loader started. That also keeps the old input when only fields outside the key change, so put everything the `queryFn` reads in the key. Prefer putting such inputs in the URL so the loader can start them, and use `experimental_waterfallHandle` when that isn't practical.

The query starts when its reader renders, like any other `useQuery` or `useSuspenseQuery`. `useQuery` doesn't fetch during a server render, while `useSuspenseQuery` does.

## Server rendering

Queries you start with handles work with the [hydration APIs](./advanced-ssr.md) like any other query.

### Streaming pending queries

`dehydrate` only includes successful queries by default. To stream a query that `load.start` started and that is still pending, opt in through `shouldDehydrateQuery`. A pending query dehydrates to a promise, so the page needs a transport that can send promises, like React Server Components, TanStack Start or React Router:

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

A Server Component can then wait for the post and stream the comments:

[//]: # 'StreamingPage'

```tsx
// app/posts/[id]/page.tsx
export default async function PostPage({ params }) {
  const queryClient = getQueryClient()
  const { handles, data } = await experimental_loadQueryHandles(
    queryClient,
    (load) => ({
      post: load.wait(postQuery, { id: params.id }),
      comments: load.start(commentsQuery, { postId: params.id }),
    }),
  )
  if (!data.post) notFound()

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <Post post={handles.post} />
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
  const { data } = useSuspenseInfiniteQuery(
    experimental_fromHandle(commentsQuery, props.comments),
  )
  return <CommentList comments={data.pages.flatMap((page) => page.comments)} />
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
const { handles } = await experimental_loadQueryHandles(
  queryClient,
  (load) => ({
    post: load.wait(postQuery, { id }),
  }),
)

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
