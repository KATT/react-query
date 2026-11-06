import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, fireEvent } from '@testing-library/react'
import {
  clearOnDispose,
  fakeTimers,
  sleep,
  unmountOnDispose,
} from '@tanstack/query-test-utils'
import {
  QueryClient,
  dehydrate,
  experimental_waterfallHandle,
  hydrate,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import { renderWithClient } from './utils'
import { createOptionsProxy } from './trpcLikeProxy'
import type { experimental_QueryHandle } from '..'
import type { OptionsProxy } from './trpcLikeProxy'

type Post = { id: string; title: string; authorId: string }
type FeedPage = { items: Array<string>; nextCursor: number | null }

describe('a tRPC-like proxy on the public handle APIs', () => {
  const createRouter = () => ({
    'post.byId': vi.fn<(input: { id: string }) => Promise<Post>>((input) =>
      sleep(10).then(() => ({
        id: input.id,
        title: `post ${input.id}`,
        authorId: 'a',
      })),
    ),
    'post.byAuthor': vi.fn<
      (input: { authorId: string }) => Promise<Array<string>>
    >((input) => sleep(10).then(() => [`post by ${input.authorId}`])),
    'post.comments': vi.fn<
      (input: { postId: string; page: number }) => Promise<Array<string>>
    >((input) =>
      sleep(10).then(() => [`comment ${input.postId}-${input.page}`]),
    ),
    feed: vi.fn<
      (input: { limit: number; cursor?: number | null }) => Promise<FeedPage>
    >((input) =>
      sleep(10).then(() => {
        const cursor = input.cursor ?? 0
        return {
          items: [`item ${cursor}`],
          nextCursor: cursor + input.limit,
        }
      }),
    ),
  })

  it('should start queries on the server and read the handles on the client', async () => {
    using _timers = fakeTimers()
    const router = createRouter()
    type TRPC = OptionsProxy<typeof router>

    using serverClient = clearOnDispose(new QueryClient())
    const serverTrpc = createOptionsProxy(router, serverClient)
    const loaded = serverTrpc.$loadHandles((load) => ({
      post: load.fetch(serverTrpc['post.byId'].queryOptions, { id: '1' }),
      comments: load.prefetch(serverTrpc['post.comments'].queryOptions, {
        postId: '1',
        page: 1,
      }),
      feed: load.fetch(
        serverTrpc.feed.infiniteQueryOptions,
        { limit: 10 },
        { pages: 2 },
      ),
    }))
    await vi.advanceTimersByTimeAsync(20)
    const [{ post, comments, feed }, loadedData] = await loaded
    expect(loadedData.post).toStrictEqual({
      id: '1',
      title: 'post 1',
      authorId: 'a',
    })
    const payload = JSON.parse(
      JSON.stringify({
        state: dehydrate(serverClient),
        post,
        comments,
        feed,
      }),
    ) as {
      state: ReturnType<typeof dehydrate>
      post: typeof post
      comments: typeof comments
      feed: typeof feed
    }

    using queryClient = clearOnDispose(new QueryClient())
    hydrate(queryClient, payload.state)
    const trpc = createOptionsProxy(router, queryClient)

    function Post(props: {
      post: experimental_QueryHandle<TRPC['post.byId']['queryOptions']>
    }) {
      const { data } = useSuspenseQuery({
        ...trpc.$fromHandle(props.post),
        select: (value) => value.title,
      })
      return <div>title: {data}</div>
    }

    function Comments(props: {
      comments: experimental_QueryHandle<TRPC['post.comments']['queryOptions']>
    }) {
      const [page, setPage] = React.useState(1)
      const handle = experimental_waterfallHandle(
        trpc['post.comments'].queryOptions,
        props.comments,
        (input) => ({ ...input, page }),
      )
      const { data } = useSuspenseQuery(trpc.$fromHandle(handle))
      return (
        <div>
          <div>comments: {data.join(', ')}</div>
          <button onClick={() => setPage(2)}>next</button>
        </div>
      )
    }

    function Feed(props: { feed: typeof feed }) {
      const { data } = useSuspenseInfiniteQuery(trpc.$fromHandle(props.feed))
      return (
        <div>feed: {data.pages.flatMap((page) => page.items).join(', ')}</div>
      )
    }

    using rendered = unmountOnDispose(
      renderWithClient(
        queryClient,
        <React.Suspense fallback="Loading...">
          <Post post={payload.post} />
          <Comments comments={payload.comments} />
          <Feed feed={payload.feed} />
        </React.Suspense>,
      ),
    )

    expect(rendered.getByText('title: post 1')).toBeInTheDocument()
    expect(rendered.getByText('comments: comment 1-1')).toBeInTheDocument()
    expect(rendered.getByText('feed: item 0, item 10')).toBeInTheDocument()
    expect(router['post.byId']).toHaveBeenCalledTimes(1)
    expect(router['post.comments']).toHaveBeenCalledTimes(1)
    expect(router.feed).toHaveBeenCalledTimes(2)

    fireEvent.click(rendered.getByText('next'))
    expect(rendered.getByText('Loading...')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(11))
    expect(rendered.getByText('comments: comment 1-2')).toBeInTheDocument()
    expect(router['post.comments']).toHaveBeenCalledTimes(2)
    expect(router['post.comments']).toHaveBeenLastCalledWith({
      postId: '1',
      page: 2,
    })
  })

  it('should start a dependent procedure once its parent has data', async () => {
    using _timers = fakeTimers()
    const router = createRouter()
    using queryClient = clearOnDispose(new QueryClient())
    const trpc = createOptionsProxy(router, queryClient)

    const promise = trpc.$loadHandles((load) => {
      const post = load.fetch(trpc['post.byId'].queryOptions, { id: '1' })
      return {
        post,
        authorPosts: load.after(post, (value) =>
          load.prefetch(trpc['post.byAuthor'].queryOptions, {
            authorId: value.authorId,
          }),
        ),
        feed: load.fetch(trpc.feed.infiniteQueryOptions, { limit: 10 }),
      }
    })

    expect(router['post.byId']).toHaveBeenCalledTimes(1)
    expect(router.feed).toHaveBeenCalledTimes(1)
    expect(router['post.byAuthor']).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    const [handles, data] = await promise

    expect(router['post.byAuthor']).toHaveBeenCalledWith({ authorId: 'a' })
    expect(data.post).toStrictEqual({
      id: '1',
      title: 'post 1',
      authorId: 'a',
    })
    expect(data.feed.pages).toStrictEqual([
      { items: ['item 0'], nextCursor: 10 },
    ])
    expect(trpc.$fromHandle(handles.authorPosts).queryKey).toStrictEqual(
      trpc['post.byAuthor'].queryOptions({ authorId: 'a' }).queryKey,
    )
    await vi.advanceTimersByTimeAsync(10)
  })
})
