import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, fireEvent } from '@testing-library/react'
import {
  clearOnDispose,
  createKey,
  fakeTimers,
  sleep,
  unmountOnDispose,
} from '@tanstack/query-test-utils'
import {
  HydrationBoundary,
  QueryClient,
  defaultShouldDehydrateQuery,
  dehydrate,
  experimental_fetchEntry,
  experimental_fromHandle,
  experimental_loadQueryHandles,
  experimental_prefetchEntry,
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import { renderWithClient } from './utils'
import type { experimental_QueryHandle } from '..'

describe('query handles', () => {
  it('should stream pending prefetch entries to readers without fetching them again', async () => {
    using _timers = fakeTimers()
    const key = createKey()
    const fetchPost = vi.fn<(id: string) => Promise<string>>((id) =>
      sleep(10).then(() => `post ${id}`),
    )
    const fetchComments = vi.fn<
      (postId: string, cursor: number) => Promise<string>
    >((postId, cursor) => sleep(20).then(() => `comment ${postId}-${cursor}`))
    const postQuery = (input: { id: string }) =>
      queryOptions({
        queryKey: [...key, 'post', input.id],
        queryFn: () => fetchPost(input.id),
        staleTime: 60 * 1000,
      })
    const commentsQuery = (input: { postId: string }) =>
      infiniteQueryOptions({
        queryKey: [...key, 'comments', input.postId],
        queryFn: ({ pageParam }) => fetchComments(input.postId, pageParam),
        initialPageParam: 0,
        getNextPageParam: (_lastPage, pages) => pages.length,
        staleTime: 60 * 1000,
      })

    using serverClient = clearOnDispose(new QueryClient())
    const loader = (params: { id: string }) =>
      experimental_loadQueryHandles(serverClient, {
        post: experimental_prefetchEntry(postQuery, params),
        comments: experimental_prefetchEntry(commentsQuery, {
          postId: params.id,
        }),
      })
    const [handles] = await loader({ id: '1' })
    const dehydrated = dehydrate(serverClient, {
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    })
    expect(dehydrated.queries.map((query) => query.state.status)).toStrictEqual(
      ['pending', 'pending'],
    )

    function Post(props: { post: experimental_QueryHandle<typeof postQuery> }) {
      const { data } = useSuspenseQuery(
        experimental_fromHandle(postQuery, props.post),
      )
      return <div>data: {data}</div>
    }

    function Comments(props: {
      comments: experimental_QueryHandle<typeof commentsQuery>
    }) {
      const { data, fetchNextPage } = useSuspenseInfiniteQuery(
        experimental_fromHandle(commentsQuery, props.comments),
      )
      return (
        <div>
          <div>comments: {data.pages.join(', ')}</div>
          <button onClick={() => fetchNextPage()}>more</button>
        </div>
      )
    }

    const payload = JSON.parse(JSON.stringify(handles)) as typeof handles
    using queryClient = clearOnDispose(new QueryClient())
    using rendered = unmountOnDispose(
      renderWithClient(
        queryClient,
        <HydrationBoundary state={dehydrated}>
          <React.Suspense fallback={<div>Loading post...</div>}>
            <Post post={payload.post} />
          </React.Suspense>
          <React.Suspense fallback={<div>Loading comments...</div>}>
            <Comments comments={payload.comments} />
          </React.Suspense>
        </HydrationBoundary>,
      ),
    )

    expect(rendered.getByText('Loading post...')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(rendered.getByText('data: post 1')).toBeInTheDocument()
    expect(rendered.getByText('Loading comments...')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(rendered.getByText('comments: comment 1-0')).toBeInTheDocument()
    expect(fetchPost).toHaveBeenCalledTimes(1)
    expect(fetchComments).toHaveBeenCalledTimes(1)

    fireEvent.click(rendered.getByText('more'))
    await act(() => vi.advanceTimersByTimeAsync(21))
    expect(
      rendered.getByText('comments: comment 1-0, comment 1-1'),
    ).toBeInTheDocument()
  })

  it('should render a fetched handle from the server without a loading state', async () => {
    using _timers = fakeTimers()
    const key = createKey()
    const fetchPost = vi.fn<(id: string) => Promise<string>>((id) =>
      sleep(10).then(() => `post ${id}`),
    )
    const postQuery = (input: { id: string }) =>
      queryOptions({
        queryKey: [...key, input.id],
        queryFn: () => fetchPost(input.id),
        staleTime: 60 * 1000,
      })

    using serverClient = clearOnDispose(new QueryClient())
    const promise = experimental_loadQueryHandles(serverClient, {
      post: experimental_fetchEntry(postQuery, { id: '1' }),
    })
    await vi.advanceTimersByTimeAsync(10)
    const [handles] = await promise
    const dehydrated = dehydrate(serverClient)

    function Post(props: { post: experimental_QueryHandle<typeof postQuery> }) {
      const { data } = useSuspenseQuery(
        experimental_fromHandle(postQuery, props.post),
      )
      return <div>data: {data}</div>
    }

    using queryClient = clearOnDispose(new QueryClient())
    using rendered = unmountOnDispose(
      renderWithClient(
        queryClient,
        <HydrationBoundary state={dehydrated}>
          <React.Suspense fallback="Loading...">
            <Post post={JSON.parse(JSON.stringify(handles.post))} />
          </React.Suspense>
        </HydrationBoundary>,
      ),
    )

    expect(rendered.getByText('data: post 1')).toBeInTheDocument()
    expect(fetchPost).toHaveBeenCalledTimes(1)
  })

  it('should give useQuery the cached data of a fetched handle on the first render', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const key = createKey()
    const postQuery = (input: { id: string }) =>
      queryOptions({
        queryKey: [...key, input.id],
        queryFn: () => sleep(10).then(() => `post ${input.id}`),
      })
    const promise = experimental_loadQueryHandles(queryClient, {
      post: experimental_fetchEntry(postQuery, { id: '1' }),
    })
    await vi.advanceTimersByTimeAsync(10)
    const [handles] = await promise
    const statuses: Array<string> = []

    function Post() {
      const { data, status } = useQuery(
        experimental_fromHandle(postQuery, handles.post),
      )
      statuses.push(status)
      return <div>data: {data}</div>
    }

    using rendered = unmountOnDispose(renderWithClient(queryClient, <Post />))

    expect(rendered.getByText('data: post 1')).toBeInTheDocument()
    expect(statuses[0]).toBe('success')
  })

  it("should read the loader's query from the factory with the handle's input", async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const key = createKey()
    const search = vi.fn<(term: string, page: number) => Promise<string>>(
      (term, page) => sleep(10).then(() => `${term} ${page}`),
    )
    const searchQuery = (input: { term: string }) =>
      infiniteQueryOptions({
        queryKey: [...key, input.term],
        queryFn: ({ pageParam }) => search(input.term, pageParam),
        initialPageParam: 1,
        getNextPageParam: (_lastPage, allPages) => allPages.length + 1,
        staleTime: 60 * 1000,
      })
    const promise = experimental_loadQueryHandles(queryClient, {
      results: experimental_fetchEntry(searchQuery, { term: 'a' }),
    })
    await vi.advanceTimersByTimeAsync(10)
    const [handles] = await promise

    function SearchBox(props: {
      results: experimental_QueryHandle<typeof searchQuery>
    }) {
      const [term, setTerm] = React.useState(props.results.input.term)
      const { data, isPlaceholderData } = useInfiniteQuery({
        ...searchQuery({ term }),
        placeholderData: keepPreviousData,
      })
      return (
        <div>
          <input
            aria-label="term"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <div>results: {data?.pages.join(', ')}</div>
          <div>{isPlaceholderData ? 'previous' : 'current'}</div>
        </div>
      )
    }

    using rendered = unmountOnDispose(
      renderWithClient(queryClient, <SearchBox results={handles.results} />),
    )

    expect(rendered.getByText('results: a 1')).toBeInTheDocument()
    expect(search).toHaveBeenCalledTimes(1)

    fireEvent.change(rendered.getByLabelText('term'), {
      target: { value: 'ab' },
    })
    expect(rendered.getByText('results: a 1')).toBeInTheDocument()
    expect(rendered.getByText('previous')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(11))
    expect(rendered.getByText('results: ab 1')).toBeInTheDocument()
    expect(rendered.getByText('current')).toBeInTheDocument()
    expect(search).toHaveBeenCalledTimes(2)
  })
})
