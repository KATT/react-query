import { describe, expect, it, vi } from 'vitest'
import {
  clearOnDispose,
  createKey,
  fakeTimers,
  sleep,
} from '@tanstack/query-test-utils'
import {
  QueryClient,
  experimental_fromHandle,
  experimental_loadQueryHandles,
} from '..'
import type { experimental_QueryHandlesBuilder } from '..'

type Post = { id: string; authorId: string | null }

describe('experimental_loadQueryHandles', () => {
  const createQueries = () => {
    const key = createKey()
    const fetchViewer = vi.fn<() => Promise<string>>(() =>
      sleep(30).then(() => 'viewer'),
    )
    const fetchPost = vi.fn<(id: string) => Promise<Post | null>>((id) =>
      sleep(10).then(() =>
        id === 'missing' ? null : { id, authorId: id === '2' ? null : 'a' },
      ),
    )
    const fetchUser = vi.fn<(id: string) => Promise<string>>((id) =>
      sleep(10).then(() => `user ${id}`),
    )
    const fetchFeed = vi.fn<
      (cursor: number) => Promise<{ items: Array<number>; next: number }>
    >((cursor) => sleep(10).then(() => ({ items: [cursor], next: cursor + 1 })))
    return {
      fetchViewer,
      fetchPost,
      fetchUser,
      fetchFeed,
      viewerQuery: () => ({
        queryKey: [...key, 'viewer'],
        queryFn: fetchViewer,
      }),
      postQuery: (input: { id: string }) => ({
        queryKey: [...key, 'post', input.id],
        queryFn: () => fetchPost(input.id),
      }),
      userQuery: (input: { id: string }) => ({
        queryKey: [...key, 'user', input.id],
        queryFn: () => fetchUser(input.id),
      }),
      feedQuery: () => ({
        queryKey: [...key, 'feed'],
        queryFn: ({ pageParam }: { pageParam: number }) => fetchFeed(pageParam),
        initialPageParam: 0,
        getNextPageParam: (page: { next: number }) => page.next,
        pages: 2,
      }),
    }
  }

  it('should start every query at once and resolve with handles and the waited data', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { viewerQuery, postQuery, fetchViewer, fetchPost } = createQueries()

    const promise = experimental_loadQueryHandles(queryClient, (q) => ({
      viewer: q.start(viewerQuery),
      post: q.wait(postQuery, { id: '1' }),
    }))

    expect(fetchViewer).toHaveBeenCalledTimes(1)
    expect(fetchPost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10)
    const { handles, data } = await promise

    expect(handles).toStrictEqual({
      viewer: { queryKey: viewerQuery().queryKey, input: undefined },
      post: { queryKey: postQuery({ id: '1' }).queryKey, input: { id: '1' } },
    })
    expect(JSON.parse(JSON.stringify(handles))).toStrictEqual({
      viewer: { queryKey: viewerQuery().queryKey },
      post: handles.post,
    })
    expect(data).toStrictEqual({ post: { id: '1', authorId: 'a' } })
    expect(queryClient.getQueryState(viewerQuery().queryKey)?.fetchStatus).toBe(
      'fetching',
    )
  })

  it('should wait for waited queries side by side', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { viewerQuery, postQuery } = createQueries()
    const onResolve = vi.fn<(value: unknown) => void>()

    void experimental_loadQueryHandles(queryClient, (q) => ({
      viewer: q.wait(viewerQuery),
      post: q.wait(postQuery, { id: '1' }),
    })).then(onResolve)

    await vi.advanceTimersByTimeAsync(29)
    expect(onResolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onResolve).toHaveBeenCalledWith({
      handles: expect.any(Object),
      data: { viewer: 'viewer', post: { id: '1', authorId: 'a' } },
    })
  })

  it('should use cached data, even if stale, for ensure', async () => {
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery, fetchPost } = createQueries()
    queryClient.setQueryData(postQuery({ id: '1' }).queryKey, {
      id: '1',
      authorId: 'cached',
    })

    const { data } = await experimental_loadQueryHandles(queryClient, (q) => ({
      post: q.ensure(postQuery, { id: '1' }),
    }))

    expect(data).toStrictEqual({ post: { id: '1', authorId: 'cached' } })
    expect(fetchPost).not.toHaveBeenCalled()
  })

  it("should start a dependent query once its parent's data is in the cache, without holding back the others", async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { viewerQuery, postQuery, userQuery, fetchViewer, fetchUser } =
      createQueries()

    const promise = experimental_loadQueryHandles(queryClient, (q) => {
      const post = q.wait(postQuery, { id: '1' })
      return {
        viewer: q.start(viewerQuery),
        post,
        author: q.after(post, (value) => {
          const authorId = (value as Post | null)?.authorId
          return authorId ? q.wait(userQuery, { id: authorId }) : null
        }),
      }
    })

    expect(fetchViewer).toHaveBeenCalledTimes(1)
    expect(fetchUser).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchUser).toHaveBeenCalledWith('a')
    await vi.advanceTimersByTimeAsync(10)
    const { handles, data } = await promise

    expect(handles.author).toStrictEqual({
      queryKey: userQuery({ id: 'a' }).queryKey,
      input: { id: 'a' },
    })
    expect(data).toStrictEqual({
      post: { id: '1', authorId: 'a' },
      author: 'user a',
    })
  })

  it('should give a dependent entry that starts nothing a null handle and data', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery, userQuery, fetchUser } = createQueries()

    const promise = experimental_loadQueryHandles(queryClient, (q) => {
      const post = q.wait(postQuery, { id: '2' })
      return {
        post,
        author: q.after(post, (value) => {
          const authorId = (value as Post | null)?.authorId
          return authorId ? q.wait(userQuery, { id: authorId }) : null
        }),
      }
    })
    await vi.advanceTimersByTimeAsync(10)
    const { handles, data } = await promise

    expect(handles.author).toBeNull()
    expect(data.author).toBeNull()
    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('should reject as soon as a dependent callback throws, like notFound()', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { viewerQuery, postQuery, userQuery } = createQueries()
    const notFound = new Error('not found')

    const promise = experimental_loadQueryHandles(queryClient, (q) => {
      const post = q.wait(postQuery, { id: 'missing' })
      return {
        viewer: q.wait(viewerQuery),
        author: q.after(post, (value) => {
          if (!value) throw notFound
          return q.wait(userQuery, { id: (value as Post).id })
        }),
      }
    })
    const onReject = vi.fn<(error: unknown) => void>()
    promise.catch(onReject)

    await vi.advanceTimersByTimeAsync(10)
    expect(onReject).toHaveBeenCalledWith(notFound)
  })

  it('should reject when a waited query fails, but not when a started one does', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const key = createKey()
    const failingQuery = () => ({
      queryKey: key,
      queryFn: () => Promise.reject(new Error('no')),
    })
    const { postQuery } = createQueries()

    const started = experimental_loadQueryHandles(queryClient, (q) => ({
      failing: q.start(failingQuery),
      post: q.wait(postQuery, { id: '1' }),
    }))
    await vi.advanceTimersByTimeAsync(10)
    await expect(started).resolves.toMatchObject({ data: { post: {} } })

    queryClient.clear()
    const waited = experimental_loadQueryHandles(queryClient, (q) => ({
      failing: q.wait(failingQuery),
    }))
    await expect(waited).rejects.toThrow('no')
  })

  it('should read the data through select, and an infinite query as pages', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery, feedQuery, fetchFeed } = createQueries()

    const promise = experimental_loadQueryHandles(queryClient, (q) => ({
      postId: q.wait(
        (input: { id: string }) => ({
          ...postQuery(input),
          select: (post: Post | null) => post?.id,
        }),
        { id: '1' },
      ),
      feed: q.wait(feedQuery),
    }))
    await vi.advanceTimersByTimeAsync(20)
    const { handles, data } = await promise

    expect(data).toStrictEqual({
      postId: '1',
      feed: {
        pages: [
          { items: [0], next: 1 },
          { items: [1], next: 2 },
        ],
        pageParams: [0, 1],
      },
    })
    expect(fetchFeed).toHaveBeenCalledTimes(2)
    expect(
      experimental_fromHandle(feedQuery, handles.feed).queryKey,
    ).toStrictEqual(feedQuery().queryKey)
  })

  it('should reject an async callback', async () => {
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery } = createQueries()

    await expect(
      experimental_loadQueryHandles(
        queryClient,
        // @ts-expect-error the callback can't return a promise
        (q) => Promise.resolve({ post: q.wait(postQuery, { id: '1' }) }),
      ),
    ).rejects.toThrow('start queries synchronously')
  })

  it('should not start queries once the callback returned', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery, fetchPost } = createQueries()
    let builder: experimental_QueryHandlesBuilder | undefined

    const promise = experimental_loadQueryHandles(queryClient, (q) => {
      builder = q
      return {}
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(() => builder!.start(postQuery, { id: '1' })).toThrow(
      'start queries only while its callback runs',
    )
    expect(fetchPost).not.toHaveBeenCalled()
    await expect(promise).resolves.toStrictEqual({ handles: {}, data: {} })
  })

  it('should reject an entry from another call or a started entry as a parent', async () => {
    using _timers = fakeTimers()
    using queryClient = clearOnDispose(new QueryClient())
    const { postQuery, userQuery, viewerQuery } = createQueries()
    let other: ReturnType<experimental_QueryHandlesBuilder['wait']> | undefined

    const first = experimental_loadQueryHandles(queryClient, (q) => {
      other = q.wait(postQuery, { id: '1' })
      return {}
    })
    await vi.advanceTimersByTimeAsync(10)
    await first

    await expect(
      experimental_loadQueryHandles(queryClient, () => ({ post: other! })),
    ).rejects.toThrow('"post" is not an entry of this call')
    await expect(
      experimental_loadQueryHandles(queryClient, (q) => {
        const viewer = q.start(viewerQuery)
        return {
          // @ts-expect-error `after` needs an entry that waits
          user: q.after(viewer, () => q.start(userQuery, { id: 'a' })),
        }
      }),
    ).rejects.toThrow('`after` takes an entry from `wait`, `ensure` or `after`')
  })
})
