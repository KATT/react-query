import { describe, expect, it, vi } from 'vitest'
import {
  clearOnDispose,
  createKey,
  fakeTimers,
  sleep,
  subscribe,
} from '@tanstack/query-test-utils'
import {
  QueryClient,
  QueryObserver,
  environmentManager,
  experimental_fromHandle,
  experimental_loadQueryHandles,
  experimental_waterfallHandle,
  noop,
} from '..'
import type { experimental_QueryHandleLoader } from '..'

type Post = { id: string; authorId: string | null }

const isServer = environmentManager.isServer()

const serverEnvironment = (): Disposable => {
  environmentManager.setIsServer(() => true)
  return {
    [Symbol.dispose]: () => {
      environmentManager.setIsServer(() => isServer)
    },
  }
}

const unhandledRejections = () => {
  const listener = vi.fn<NodeJS.UnhandledRejectionListener>()
  process.on('unhandledRejection', listener)
  return Object.assign(listener, {
    [Symbol.dispose]: () => {
      process.off('unhandledRejection', listener)
    },
  })
}

describe('query handles', () => {
  const createPostQuery = (
    queryFn = (id: string) => sleep(10).then(() => id),
  ) => {
    const key = createKey()
    return (input: { id: string }) => ({
      queryKey: [...key, input.id],
      queryFn: () => queryFn(input.id),
    })
  }

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
    const fetchAuthorPosts = vi.fn<(authorId: string) => Promise<string>>(
      (authorId) => sleep(10).then(() => `posts by ${authorId}`),
    )
    return {
      fetchViewer,
      fetchPost,
      fetchAuthorPosts,
      viewerQuery: () => ({
        queryKey: [...key, 'viewer'],
        queryFn: fetchViewer,
      }),
      postQuery: (input: { id: string }) => ({
        queryKey: [...key, 'post', input.id],
        queryFn: () => fetchPost(input.id),
      }),
      authorPostsQuery: (input: { authorId: string }) => ({
        queryKey: [...key, 'authorPosts', input.authorId],
        queryFn: () => fetchAuthorPosts(input.authorId),
      }),
    }
  }

  describe('experimental_loadQueryHandles', () => {
    it('should start every query at once and resolve with handles and the waited data', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const { viewerQuery, postQuery, fetchViewer, fetchPost } = createQueries()

      const promise = experimental_loadQueryHandles(queryClient, (load) => ({
        viewer: load.start(viewerQuery),
        post: load.wait(postQuery, { id: '1' }),
      }))

      expect(fetchViewer).toHaveBeenCalledTimes(1)
      expect(fetchPost).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10)
      const { handles, data } = await promise

      expect(handles).toStrictEqual({
        viewer: { queryKey: viewerQuery().queryKey, input: undefined },
        post: {
          queryKey: postQuery({ id: '1' }).queryKey,
          input: { id: '1' },
        },
      })
      expect(JSON.parse(JSON.stringify(handles))).toStrictEqual({
        viewer: { queryKey: viewerQuery().queryKey },
        post: handles.post,
      })
      expect(data).toStrictEqual({ post: { id: '1', authorId: 'a' } })
      expect(
        queryClient.getQueryState(viewerQuery().queryKey)?.fetchStatus,
      ).toBe('fetching')
    })

    it('should wait for waited queries side by side', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const { viewerQuery, postQuery } = createQueries()
      const onResolve = vi.fn<(value: unknown) => void>()

      void experimental_loadQueryHandles(queryClient, (load) => ({
        viewer: load.wait(viewerQuery),
        post: load.wait(postQuery, { id: '1' }),
      })).then(onResolve)

      await vi.advanceTimersByTimeAsync(29)
      expect(onResolve).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onResolve).toHaveBeenCalledWith({
        handles: expect.any(Object),
        data: { viewer: 'viewer', post: { id: '1', authorId: 'a' } },
      })
    })

    describe('load.start', () => {
      it('should not reject or cause an unhandled rejection when the query fails', async () => {
        using onUnhandledRejection = unhandledRejections()
        using queryClient = clearOnDispose(new QueryClient())
        const rejecting = createPostQuery(() => Promise.reject(new Error('no')))
        const throwing = createPostQuery(() => {
          throw new Error('no')
        })

        const { handles } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({
            rejecting: load.start(rejecting, { id: '1' }),
            throwing: load.start(throwing, { id: '1' }),
          }),
        )
        await sleep(0)

        expect(handles.rejecting.input).toStrictEqual({ id: '1' })
        expect(onUnhandledRejection).not.toHaveBeenCalled()
        expect(
          queryClient.getQueryState(rejecting({ id: '1' }).queryKey)?.status,
        ).toBe('error')
        expect(
          queryClient.getQueryState(throwing({ id: '1' }).queryKey)?.status,
        ).toBe('error')
      })

      it('should not refetch fresh data', async () => {
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const queryFn = vi.fn<() => Promise<string>>(() =>
          Promise.resolve('new'),
        )
        const postQuery = (input: { id: string }) => ({
          queryKey: [...key, input.id],
          queryFn,
          staleTime: Infinity,
        })
        queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')

        await experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.start(postQuery, { id: '1' }),
        }))

        expect(queryFn).not.toHaveBeenCalled()
      })

      it('should start an infinite query for infinite options, with or without getNextPageParam', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const feedQuery = (input: { size: number }) => ({
          queryKey: [...key, input.size],
          queryFn: ({ pageParam }: { pageParam: number }) => pageParam * 10,
          initialPageParam: 1,
          getNextPageParam: (lastPage: number) => lastPage + 1,
        })
        const pagelessQuery = (input: { size: number }) => ({
          queryKey: [...key, 'pageless', input.size],
          queryFn: ({ pageParam }: { pageParam: number }) => pageParam * 10,
          initialPageParam: 1,
        })

        await experimental_loadQueryHandles(queryClient, (load) => ({
          feed: load.start(feedQuery, { size: 1 }),
          pageless: load.start(pagelessQuery, { size: 1 }),
        }))
        await vi.advanceTimersByTimeAsync(0)

        expect(queryClient.getQueryData([...key, 1])).toStrictEqual({
          pages: [10],
          pageParams: [1],
        })
        expect(queryClient.getQueryData([...key, 'pageless', 1])).toStrictEqual(
          { pages: [10], pageParams: [1] },
        )
      })
    })

    describe('load.wait', () => {
      it('should wait for fresh data when the cached data is stale', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const postQuery = createPostQuery((id) =>
          sleep(10).then(() => `${id}-new`),
        )
        queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')

        const promise = experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.wait(postQuery, { id: '1' }),
        }))
        await vi.advanceTimersByTimeAsync(10)

        await expect(promise).resolves.toMatchObject({
          data: { post: '1-new' },
        })
      })

      it('should reject when a waited query fails, but not when a started one does', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const failingQuery = createPostQuery(() =>
          Promise.reject(new Error('no')),
        )
        const { postQuery } = createQueries()

        const started = experimental_loadQueryHandles(queryClient, (load) => ({
          failing: load.start(failingQuery, { id: '1' }),
          post: load.wait(postQuery, { id: '1' }),
        }))
        await vi.advanceTimersByTimeAsync(10)
        await expect(started).resolves.toMatchObject({ data: { post: {} } })

        await expect(
          experimental_loadQueryHandles(queryClient, (load) => ({
            failing: load.wait(failingQuery, { id: '2' }),
          })),
        ).rejects.toThrow('no')
      })

      it('should fetch the pages it is asked for, and leave them out of the options readers get', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const commentsQuery = (input: { postId: string }) => ({
          queryKey: [...key, input.postId],
          queryFn: ({ pageParam }: { pageParam: number }) =>
            sleep(10).then(() => [`${input.postId}-${pageParam}`]),
          initialPageParam: 1,
          getNextPageParam: (_: Array<string>, pages: Array<unknown>) =>
            pages.length + 1,
        })

        const promise = experimental_loadQueryHandles(queryClient, (load) => ({
          comments: load.wait(commentsQuery, { postId: '1' }, { pages: 2 }),
        }))
        await vi.advanceTimersByTimeAsync(20)
        const { handles, data } = await promise

        expect(data.comments).toStrictEqual({
          pages: [['1-1'], ['1-2']],
          pageParams: [1, 2],
        })
        expect(
          experimental_fromHandle(commentsQuery, handles.comments),
        ).not.toHaveProperty('pages')
      })
    })

    describe('load.ensure', () => {
      it('should fetch once and wait when the cache has no data', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const { postQuery, fetchPost } = createQueries()

        const promise = experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.ensure(postQuery, { id: '1' }),
        }))
        await vi.advanceTimersByTimeAsync(10)

        await expect(promise).resolves.toMatchObject({
          data: { post: { id: '1' } },
        })
        expect(fetchPost).toHaveBeenCalledTimes(1)
      })

      it('should resolve at once with stale cached data, and let the reader refetch it on mount', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
          sleep(10).then(() => `${id}-new`),
        )
        const postQuery = createPostQuery(queryFn)
        queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')

        const { handles, data } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({ post: load.ensure(postQuery, { id: '1' }) }),
        )

        expect(data.post).toBe('cached')
        expect(queryFn).not.toHaveBeenCalled()
        const observer = new QueryObserver(
          queryClient,
          experimental_fromHandle(postQuery, handles.post),
        )
        using _subscription = subscribe(observer, noop)
        expect(observer.getCurrentResult().data).toBe('cached')
        expect(queryFn).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(10)
        expect(observer.getCurrentResult().data).toBe('1-new')
      })

      it('should use cached pages of an infinite query', async () => {
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const queryFn = vi.fn<(context: { pageParam: number }) => number>(
          ({ pageParam }) => pageParam,
        )
        const feedQuery = () => ({
          queryKey: key,
          queryFn,
          initialPageParam: 1,
          getNextPageParam: (lastPage: number) => lastPage + 1,
        })
        queryClient.setQueryData(key, { pages: [1], pageParams: [1] })

        const { data } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({ feed: load.ensure(feedQuery, undefined, { pages: 2 }) }),
        )

        expect(queryFn).not.toHaveBeenCalled()
        expect(data.feed).toStrictEqual({ pages: [1], pageParams: [1] })
      })

      it("should leave the factory's staleTime to readers and later loads", async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
          sleep(10).then(() => id),
        )
        const key = createKey()
        const postQuery = (input: { id: string }) => ({
          queryKey: [...key, input.id],
          queryFn: () => queryFn(input.id),
          staleTime: 1000,
        })
        queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')
        vi.advanceTimersByTime(1000)

        const { handles } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({ post: load.ensure(postQuery, { id: '1' }) }),
        )

        expect(experimental_fromHandle(postQuery, handles.post).staleTime).toBe(
          1000,
        )
        expect(queryFn).not.toHaveBeenCalled()
        await experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.start(postQuery, { id: '1' }),
        }))
        expect(queryFn).toHaveBeenCalledTimes(1)
      })
    })

    describe('data', () => {
      it("should be what the factory's select returns", async () => {
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const postQuery = (input: { id: string }) => ({
          queryKey: [...key, input.id],
          queryFn: () => ({ id: input.id, title: `post ${input.id}` }),
          select: (post: { id: string; title: string }) => post.title,
        })

        const { data } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({ post: load.wait(postQuery, { id: '1' }) }),
        )

        expect(data.post).toBe('post 1')
      })

      it("should find the query with the factory's queryKeyHashFn", async () => {
        using queryClient = clearOnDispose(new QueryClient())
        const key = createKey()
        const postQuery = (input: { id: string }) => ({
          queryKey: [...key, input.id],
          queryFn: () => input.id,
          queryKeyHashFn: (queryKey: ReadonlyArray<unknown>) =>
            `custom:${queryKey.join('/')}`,
        })

        const { data } = await experimental_loadQueryHandles(
          queryClient,
          (load) => ({ post: load.wait(postQuery, { id: '1' }) }),
        )

        expect(data.post).toBe('1')
      })

      it('should let a loader throw a 404 for a post that does not exist', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        class NotFoundError extends Error {}
        const { viewerQuery, postQuery } = createQueries()
        const loader = async (params: { id: string }) => {
          const { handles, data } = await experimental_loadQueryHandles(
            queryClient,
            (load) => ({
              viewer: load.start(viewerQuery),
              post: load.wait(postQuery, params),
            }),
          )
          if (!data.post) throw new NotFoundError()
          return handles
        }

        const found = loader({ id: '1' })
        const missing = loader({ id: 'missing' })
        missing.catch(noop)
        await vi.advanceTimersByTimeAsync(10)

        await expect(found).resolves.toMatchObject({
          post: { input: { id: '1' } },
        })
        await expect(missing).rejects.toBeInstanceOf(NotFoundError)
      })
    })

    describe('load.after', () => {
      it("should start a dependent query once its parent's data is in the cache, without holding back the others", async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const {
          viewerQuery,
          postQuery,
          authorPostsQuery,
          fetchViewer,
          fetchAuthorPosts,
        } = createQueries()

        const promise = experimental_loadQueryHandles(queryClient, (load) => {
          const post = load.wait(postQuery, { id: '1' })
          return {
            viewer: load.start(viewerQuery),
            post,
            authorPosts: load.after(post, (value) => {
              const authorId = (value as Post | null)?.authorId
              return authorId ? load.wait(authorPostsQuery, { authorId }) : null
            }),
          }
        })

        expect(fetchViewer).toHaveBeenCalledTimes(1)
        expect(fetchAuthorPosts).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(10)
        expect(fetchAuthorPosts).toHaveBeenCalledWith('a')
        await vi.advanceTimersByTimeAsync(10)
        const { handles, data } = await promise

        expect(handles.authorPosts).toStrictEqual({
          queryKey: authorPostsQuery({ authorId: 'a' }).queryKey,
          input: { authorId: 'a' },
        })
        expect(data).toStrictEqual({
          post: { id: '1', authorId: 'a' },
          authorPosts: 'posts by a',
        })
      })

      it('should give a dependent query that starts nothing a null handle and data', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const { postQuery, authorPostsQuery, fetchAuthorPosts } =
          createQueries()

        const promise = experimental_loadQueryHandles(queryClient, (load) => {
          const post = load.wait(postQuery, { id: '2' })
          return {
            post,
            authorPosts: load.after(post, (value) => {
              const authorId = (value as Post | null)?.authorId
              return authorId ? load.wait(authorPostsQuery, { authorId }) : null
            }),
          }
        })
        await vi.advanceTimersByTimeAsync(10)
        const { handles, data } = await promise

        expect(handles.authorPosts).toBeNull()
        expect(data.authorPosts).toBeNull()
        expect(fetchAuthorPosts).not.toHaveBeenCalled()
      })

      it('should reject as soon as a callback throws, like notFound()', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const { viewerQuery, postQuery, authorPostsQuery } = createQueries()
        const notFound = new Error('not found')

        const promise = experimental_loadQueryHandles(queryClient, (load) => {
          const post = load.wait(postQuery, { id: 'missing' })
          return {
            viewer: load.wait(viewerQuery),
            authorPosts: load.after(post, (value) => {
              if (!value) throw notFound
              return load.wait(authorPostsQuery, { authorId: 'a' })
            }),
          }
        })
        const onReject = vi.fn<(error: unknown) => void>()
        promise.catch(onReject)

        await vi.advanceTimersByTimeAsync(10)
        expect(onReject).toHaveBeenCalledWith(notFound)
      })
    })

    describe('the callback', () => {
      it('should not return a promise', async () => {
        using queryClient = clearOnDispose(new QueryClient())
        const { postQuery } = createQueries()

        const asyncCallback = (load: experimental_QueryHandleLoader) =>
          Promise.resolve({ post: load.wait(postQuery, { id: '1' }) })

        await expect(
          // @ts-expect-error the callback can't return a promise
          experimental_loadQueryHandles(queryClient, asyncCallback),
        ).rejects.toThrow('start queries synchronously')
      })

      it('should not let load start queries once it returned', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const { postQuery, fetchPost } = createQueries()
        let loader: experimental_QueryHandleLoader | undefined

        const promise = experimental_loadQueryHandles(queryClient, (load) => {
          loader = load
          return {}
        })
        await vi.advanceTimersByTimeAsync(0)

        expect(() => loader!.start(postQuery, { id: '1' })).toThrow(
          'start queries only while its callback runs',
        )
        expect(fetchPost).not.toHaveBeenCalled()
        await expect(promise).resolves.toStrictEqual({ handles: {}, data: {} })
      })

      it('should reject a query from another call, or a started query as a parent', async () => {
        using _timers = fakeTimers()
        using queryClient = clearOnDispose(new QueryClient())
        const { postQuery, authorPostsQuery, viewerQuery } = createQueries()
        let other:
          | ReturnType<experimental_QueryHandleLoader['wait']>
          | undefined

        const first = experimental_loadQueryHandles(queryClient, (load) => {
          other = load.wait(postQuery, { id: '1' })
          return {}
        })
        await vi.advanceTimersByTimeAsync(10)
        await first

        await expect(
          experimental_loadQueryHandles(queryClient, () => ({ post: other! })),
        ).rejects.toThrow('"post" is not a query of this call')
        await expect(
          experimental_loadQueryHandles(queryClient, (load) => {
            const viewer = load.start(viewerQuery)
            return {
              // @ts-expect-error `after` needs a query that the load waits for
              posts: load.after(viewer, () =>
                load.start(authorPostsQuery, { authorId: 'a' }),
              ),
            }
          }),
        ).rejects.toThrow('`load.after` takes a query from `load.wait`')
      })
    })

    describe('on a server client', () => {
      it('should follow staleTime as a browser client does', async () => {
        using _timers = fakeTimers()
        using _server = serverEnvironment()
        using queryClient = clearOnDispose(new QueryClient())
        const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
          sleep(10).then(() => id),
        )
        const postQuery = createPostQuery(queryFn)
        const load = () =>
          experimental_loadQueryHandles(queryClient, (q) => ({
            post: q.wait(postQuery, { id: '1' }),
          }))

        const first = load()
        await vi.advanceTimersByTimeAsync(10)
        await first
        expect(queryFn).toHaveBeenCalledTimes(1)

        // staleTime defaults to 0, so the data is already stale
        const second = load()
        expect(queryFn).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(10)
        await second
      })

      it('should not refetch data that is fresh by staleTime', async () => {
        using _timers = fakeTimers()
        using _server = serverEnvironment()
        using queryClient = clearOnDispose(
          new QueryClient({
            defaultOptions: { queries: { staleTime: 60 * 1000 } },
          }),
        )
        const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
          sleep(10).then(() => id),
        )
        const postQuery = createPostQuery(queryFn)

        const first = experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.wait(postQuery, { id: '1' }),
        }))
        await vi.advanceTimersByTimeAsync(10)
        await first
        await experimental_loadQueryHandles(queryClient, (load) => ({
          started: load.start(postQuery, { id: '1' }),
          waited: load.wait(postQuery, { id: '1' }),
        }))

        expect(queryFn).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('experimental_fromHandle', () => {
    it("should rebuild the factory's options for the handle's input", () => {
      const postQuery = createPostQuery()
      const handle = experimental_waterfallHandle(postQuery, { id: '1' })

      const options = experimental_fromHandle(postQuery, handle)

      expect(options).toStrictEqual({
        ...postQuery({ id: '1' }),
        queryFn: expect.any(Function),
      })
      expect(options).not.toHaveProperty('initialData')
    })

    it('should take read-site options spread over it', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const { handles } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({ post: load.start(postQuery, { id: '1' }) }),
      )
      await vi.advanceTimersByTimeAsync(10)

      const observer = new QueryObserver(queryClient, {
        ...experimental_fromHandle(postQuery, handles.post),
        select: (data) => String(data).length,
      })

      expect(observer.getCurrentResult().data).toBe(1)
    })

    it('should add no initialData for a waited handle', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const promise = experimental_loadQueryHandles(queryClient, (load) => ({
        post: load.wait(postQuery, { id: '1' }),
      }))
      await vi.advanceTimersByTimeAsync(10)
      const { handles } = await promise

      const options = experimental_fromHandle(postQuery, handles.post)

      expect(options).not.toHaveProperty('initialData')
      expect(options).not.toHaveProperty('initialDataUpdatedAt')
    })

    it('should leave a reader with no data after the cache is cleared', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const promise = experimental_loadQueryHandles(queryClient, (load) => ({
        post: load.wait(postQuery, { id: '1' }),
      }))
      await vi.advanceTimersByTimeAsync(10)
      const { handles } = await promise
      const options = {
        ...experimental_fromHandle(postQuery, handles.post),
        enabled: false,
      }
      const observer = new QueryObserver(queryClient, options)
      using _subscription = subscribe(observer, noop)

      queryClient.clear()
      // The reader renders again
      observer.setOptions(options)

      expect(queryClient.getQueryData(handles.post.queryKey)).toBeUndefined()
      expect(observer.getCurrentResult()).toMatchObject({
        status: 'pending',
        data: undefined,
      })
    })
  })

  describe('experimental_waterfallHandle', () => {
    it('should build a handle for the input without starting the query', () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
        sleep(10).then(() => id),
      )
      const postQuery = createPostQuery(queryFn)

      const handle = experimental_waterfallHandle(postQuery, { id: '1' })

      expect(handle).toStrictEqual({
        queryKey: postQuery({ id: '1' }).queryKey,
        input: { id: '1' },
      })
      expect(queryFn).not.toHaveBeenCalled()
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    })

    it('should give a factory without input an undefined input', () => {
      const key = createKey()
      const viewerQuery = () => ({ queryKey: key, queryFn: () => 'viewer' })

      expect(experimental_waterfallHandle(viewerQuery)).toStrictEqual({
        queryKey: key,
        input: undefined,
      })
    })

    it('should return the same handle while the new input maps to its query', () => {
      const key = createKey()
      const postQuery = (input: { id: string; locale?: string }) => ({
        queryKey: [...key, input.id],
        queryFn: () => input.id,
      })
      const previous = experimental_waterfallHandle(postQuery, { id: '1' })

      expect(
        experimental_waterfallHandle(postQuery, previous, (input) => ({
          ...input,
          locale: 'en',
        })),
      ).toBe(previous)
      expect(
        experimental_waterfallHandle(postQuery, previous, () => ({ id: '2' })),
      ).toStrictEqual({
        queryKey: [...key, '2'],
        input: { id: '2' },
      })
    })

    it("should compare keys with the factory's queryKeyHashFn", () => {
      const key = createKey()
      const postQuery = (input: { id: string }) => ({
        queryKey: [...key, input.id],
        queryFn: () => input.id,
        queryKeyHashFn: () => 'same',
      })
      const previous = experimental_waterfallHandle(postQuery, { id: '1' })

      expect(
        experimental_waterfallHandle(postQuery, previous, () => ({ id: '2' })),
      ).toBe(previous)
    })
  })
})
