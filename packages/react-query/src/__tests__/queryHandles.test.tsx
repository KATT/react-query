import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from '@testing-library/react'
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
  experimental_fromHandle,
  experimental_loadQueryHandles,
  infiniteQueryOptions,
  queryOptions,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import { renderWithClient } from './utils'
import type { experimental_QueryHandle } from '..'

describe('query handles', () => {
  it('should stream a pending query from a load to a reader without fetching it again', async () => {
    using _timers = fakeTimers()
    const key = createKey()
    const fetchPost = vi.fn<(id: string) => Promise<string>>((id) =>
      sleep(10).then(() => `post ${id}`),
    )
    const fetchComments = vi.fn<
      (postId: string, page: number) => Promise<Array<string>>
    >((postId, page) => sleep(20).then(() => [`comment ${postId}-${page}`]))
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
        initialPageParam: 1,
        getNextPageParam: (_lastPage, pages) => pages.length + 1,
        staleTime: 60 * 1000,
      })

    using serverClient = clearOnDispose(new QueryClient())
    const loaded = experimental_loadQueryHandles(serverClient, (load) => ({
      post: load.fetch(postQuery, { id: '1' }),
      comments: load.prefetch(commentsQuery, { postId: '1' }),
    }))
    await vi.advanceTimersByTimeAsync(10)
    const [handles] = await loaded
    const dehydrated = dehydrate(serverClient, {
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    })
    expect(dehydrated.queries.map((query) => query.state.status)).toStrictEqual(
      ['success', 'pending'],
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
      const { data } = useSuspenseInfiniteQuery(
        experimental_fromHandle(commentsQuery, props.comments),
      )
      return <div>comments: {data.pages.flat().join(', ')}</div>
    }

    const payload = JSON.parse(JSON.stringify(handles)) as typeof handles
    using queryClient = clearOnDispose(new QueryClient())
    using rendered = unmountOnDispose(
      renderWithClient(
        queryClient,
        <HydrationBoundary state={dehydrated}>
          <Post post={payload.post} />
          <React.Suspense fallback="Loading...">
            <Comments comments={payload.comments} />
          </React.Suspense>
        </HydrationBoundary>,
      ),
    )

    expect(rendered.getByText('data: post 1')).toBeInTheDocument()
    expect(rendered.getByText('Loading...')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(rendered.getByText('comments: comment 1-1')).toBeInTheDocument()
    expect(fetchPost).toHaveBeenCalledTimes(1)
    expect(fetchComments).toHaveBeenCalledTimes(1)
  })
})
