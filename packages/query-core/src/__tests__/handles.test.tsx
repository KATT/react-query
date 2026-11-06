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
  experimental_ensureEntry,
  experimental_fetchEntry,
  experimental_fromHandle,
  experimental_loadQueryHandles,
  experimental_prefetchEntry,
  experimental_waterfallHandle,
  noop,
} from '..'

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

  describe('entries', () => {
    it('should start nothing until they are loaded', () => {
      using queryClient = clearOnDispose(new QueryClient())
      const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
        sleep(10).then(() => id),
      )
      const postQuery = createPostQuery(queryFn)

      const entries = [
        experimental_prefetchEntry(postQuery, { id: '1' }),
        experimental_fetchEntry(postQuery, { id: '1' }),
        experimental_ensureEntry(postQuery, { id: '1' }),
      ]

      expect(entries.map((entry) => entry.kind)).toStrictEqual([
        'prefetch',
        'fetch',
        'ensure',
      ])
      expect(queryFn).not.toHaveBeenCalled()
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    })
  })

  describe('experimental_loadQueryHandles', () => {
    it('should start every entry before it waits, and return serializable handles', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const key = createKey()
      const viewerQuery = () => ({
        queryKey: key,
        queryFn: () => sleep(20).then(() => 'viewer'),
      })

      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
        viewer: experimental_prefetchEntry(viewerQuery),
      })

      expect(queryClient.getQueryState(key)?.fetchStatus).toBe('fetching')
      await vi.advanceTimersByTimeAsync(10)
      const { handles } = await promise

      expect(handles).toStrictEqual({
        post: { queryKey: postQuery({ id: '1' }).queryKey, input: { id: '1' } },
        viewer: { queryKey: key, input: undefined },
      })
      expect(JSON.parse(JSON.stringify(handles))).toStrictEqual({
        post: handles.post,
        viewer: { queryKey: key },
      })
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe('fetching')
    })

    it('should wait for fetch and ensure entries side by side', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery((id) => sleep(10).then(() => id))
      const commentsQuery = createPostQuery((id) => sleep(20).then(() => id))
      const onResolve = vi.fn<(value: unknown) => void>()

      void experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
        comments: experimental_ensureEntry(commentsQuery, { id: '1' }),
      }).then(onResolve)

      await vi.advanceTimersByTimeAsync(19)
      expect(onResolve).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onResolve).toHaveBeenCalledWith({
        handles: expect.any(Object),
        data: { post: '1', comments: '1' },
      })
    })

    it('should resolve at once with only prefetch entries', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()

      const { handles, data } = await experimental_loadQueryHandles(
        queryClient,
        { post: experimental_prefetchEntry(postQuery, { id: '1' }) },
      )

      expect(handles.post.input).toStrictEqual({ id: '1' })
      expect(data).toStrictEqual({})
      expect(
        queryClient.getQueryState(postQuery({ id: '1' }).queryKey)?.fetchStatus,
      ).toBe('fetching')
    })

    it('should reject as soon as a fetch entry fails, without waiting for the others', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const failingQuery = createPostQuery(() =>
        sleep(5).then(() => Promise.reject(new Error('no'))),
      )
      const slowQuery = createPostQuery((id) => sleep(50).then(() => id))
      const onReject = vi.fn<(error: unknown) => void>()

      experimental_loadQueryHandles(queryClient, {
        failing: experimental_fetchEntry(failingQuery, { id: '1' }),
        slow: experimental_fetchEntry(slowQuery, { id: '1' }),
      }).catch(onReject)
      await vi.advanceTimersByTimeAsync(5)

      expect(onReject).toHaveBeenCalledWith(new Error('no'))
      await vi.advanceTimersByTimeAsync(45)
    })

    it('should not cause an unhandled rejection when a second waited entry fails after the first', async () => {
      using onUnhandledRejection = unhandledRejections()
      using queryClient = clearOnDispose(new QueryClient())
      const failingQuery = createPostQuery(() =>
        Promise.reject(new Error('no')),
      )

      await expect(
        experimental_loadQueryHandles(queryClient, {
          first: experimental_fetchEntry(failingQuery, { id: '1' }),
          second: experimental_ensureEntry(failingQuery, { id: '2' }),
        }),
      ).rejects.toThrow('no')
      await sleep(0)

      expect(onUnhandledRejection).not.toHaveBeenCalled()
    })
  })

  describe('experimental_prefetchEntry', () => {
    it('should not reject when the query fails', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery(() => Promise.reject(new Error('no')))

      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(
        queryClient.getQueryState(postQuery({ id: '1' }).queryKey)?.status,
      ).toBe('error')
    })

    it('should not cause an unhandled rejection when the queryFn rejects at once', async () => {
      using onUnhandledRejection = unhandledRejections()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery(() => Promise.reject(new Error('no')))

      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      await sleep(0)

      expect(onUnhandledRejection).not.toHaveBeenCalled()
      expect(
        queryClient.getQueryState(postQuery({ id: '1' }).queryKey)?.status,
      ).toBe('error')
    })

    it('should not cause an unhandled rejection when the queryFn throws synchronously', async () => {
      using onUnhandledRejection = unhandledRejections()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery(() => {
        throw new Error('no')
      })

      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      await sleep(0)

      expect(onUnhandledRejection).not.toHaveBeenCalled()
      expect(
        queryClient.getQueryState(postQuery({ id: '1' }).queryKey)?.status,
      ).toBe('error')
    })

    it('should not refetch fresh data', async () => {
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const queryFn = vi.fn<() => Promise<string>>(() => Promise.resolve('new'))
      const postQuery = (input: { id: string }) => ({
        queryKey: [...key, input.id],
        queryFn,
        staleTime: Infinity,
      })
      queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')

      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })

      expect(queryFn).not.toHaveBeenCalled()
    })

    it('should start an infinite query for infinite options', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const feedQuery = (input: { size: number }) => ({
        queryKey: [...key, input.size],
        queryFn: ({ pageParam }: { pageParam: number }) => pageParam * 10,
        initialPageParam: 1,
        getNextPageParam: (lastPage: number) => lastPage + 1,
      })

      await experimental_loadQueryHandles(queryClient, {
        feed: experimental_prefetchEntry(feedQuery, { size: 1 }),
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(queryClient.getQueryData([...key, 1])).toStrictEqual({
        pages: [10],
        pageParams: [1],
      })
    })

    it('should start an infinite query for infinite options without getNextPageParam', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const feedQuery = (input: { size: number }) => ({
        queryKey: [...key, input.size],
        queryFn: ({ pageParam }: { pageParam: number }) => pageParam * 10,
        initialPageParam: 1,
      })

      await experimental_loadQueryHandles(queryClient, {
        feed: experimental_prefetchEntry(feedQuery, { size: 1 }),
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(queryClient.getQueryData([...key, 1])).toStrictEqual({
        pages: [10],
        pageParams: [1],
      })
    })
  })

  describe('experimental_fetchEntry', () => {
    it('should wait for the data and give it', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()

      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)
      const { handles, data } = await promise

      expect(handles.post).toStrictEqual({
        queryKey: postQuery({ id: '1' }).queryKey,
        input: { id: '1' },
      })
      expect(data).toStrictEqual({ post: '1' })
    })

    it('should wait for fresh data when the cached data is stale', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery((id) =>
        sleep(10).then(() => `${id}-new`),
      )
      queryClient.setQueryData(postQuery({ id: '1' }).queryKey, 'cached')

      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)

      await expect(promise).resolves.toMatchObject({
        data: { post: '1-new' },
      })
    })

    it('should reject when the fetch fails', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery(() => Promise.reject(new Error('no')))

      await expect(
        experimental_loadQueryHandles(queryClient, {
          post: experimental_fetchEntry(postQuery, { id: '1' }),
        }),
      ).rejects.toThrow('no')
    })

    it('should load the pages an infinite factory asks for, and give them as data', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const feedQuery = (input: { pages: number }) => ({
        queryKey: key,
        queryFn: ({ pageParam }: { pageParam: number }) => pageParam * 10,
        initialPageParam: 1,
        getNextPageParam: (lastPage: number) => lastPage / 10 + 1,
        pages: input.pages,
      })
      queryClient.setQueryData(key, { pages: [10], pageParams: [1] })

      const { data } = await experimental_loadQueryHandles(queryClient, {
        feed: experimental_fetchEntry(feedQuery, { pages: 2 }),
      })

      expect(data.feed).toStrictEqual({
        pages: [10, 20],
        pageParams: [1, 2],
      })
    })

    it("should give what the factory's select returns", async () => {
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const postQuery = (input: { id: string }) => ({
        queryKey: [...key, input.id],
        queryFn: () => ({ id: input.id, title: `post ${input.id}` }),
        select: (post: { id: string; title: string }) => post.title,
      })

      const { data } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })

      expect(data.post).toBe('post 1')
    })

    it("should find the data with the factory's queryKeyHashFn", async () => {
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const postQuery = (input: { id: string }) => ({
        queryKey: [...key, input.id],
        queryFn: () => input.id,
        queryKeyHashFn: (queryKey: ReadonlyArray<unknown>) =>
          `custom:${queryKey.join('/')}`,
      })

      const { data } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })

      expect(data.post).toBe('1')
    })
  })

  describe('experimental_ensureEntry', () => {
    it('should fetch once and wait when the cache has no data', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const queryFn = vi.fn<(id: string) => Promise<string>>((id) =>
        sleep(10).then(() => id),
      )
      const postQuery = createPostQuery(queryFn)

      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_ensureEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)

      await expect(promise).resolves.toStrictEqual({
        handles: {
          post: {
            queryKey: postQuery({ id: '1' }).queryKey,
            input: { id: '1' },
          },
        },
        data: { post: '1' },
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
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
        { post: experimental_ensureEntry(postQuery, { id: '1' }) },
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

    it('should reject when the fetch fails and the cache has no data', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery(() => Promise.reject(new Error('no')))

      await expect(
        experimental_loadQueryHandles(queryClient, {
          post: experimental_ensureEntry(postQuery, { id: '1' }),
        }),
      ).rejects.toThrow('no')
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

      const { data } = await experimental_loadQueryHandles(queryClient, {
        feed: experimental_ensureEntry(feedQuery),
      })

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

      const { handles } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_ensureEntry(postQuery, { id: '1' }),
      })

      expect(experimental_fromHandle(postQuery, handles.post).staleTime).toBe(
        1000,
      )
      expect(queryFn).not.toHaveBeenCalled()
      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('in a loader', () => {
    type Post = { title: string; authorId: string }

    const createBlog = () => {
      const key = createKey()
      const posts: Record<string, Post | undefined> = {
        '1': { title: 'Hello', authorId: 'a' },
      }
      const fetchAuthorPosts = vi.fn<
        (authorId: string) => Promise<Array<string>>
      >((authorId) => sleep(10).then(() => [`more by ${authorId}`]))
      return {
        fetchAuthorPosts,
        postQuery: (input: { id: string }) => ({
          queryKey: [...key, 'post', input.id],
          queryFn: () => sleep(10).then(() => posts[input.id] ?? null),
        }),
        authorPostsQuery: (input: { authorId: string }) => ({
          queryKey: [...key, 'author-posts', input.authorId],
          queryFn: () => fetchAuthorPosts(input.authorId),
        }),
        viewerQuery: () => ({
          queryKey: [...key, 'viewer'],
          queryFn: () => sleep(30).then(() => 'viewer'),
        }),
      }
    }

    it('should let a loader throw a 404 for a post that does not exist', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      class NotFoundError extends Error {}
      const { postQuery, viewerQuery } = createBlog()
      const loader = async (params: { id: string }) => {
        const { handles, data } = await experimental_loadQueryHandles(
          queryClient,
          {
            viewer: experimental_prefetchEntry(viewerQuery),
            post: experimental_fetchEntry(postQuery, params),
          },
        )
        if (!data.post) throw new NotFoundError()
        return handles
      }

      const found = loader({ id: '1' })
      await vi.advanceTimersByTimeAsync(10)
      await expect(found).resolves.toStrictEqual({
        viewer: { queryKey: viewerQuery().queryKey, input: undefined },
        post: { queryKey: postQuery({ id: '1' }).queryKey, input: { id: '1' } },
      })
      const missing = loader({ id: '2' })
      missing.catch(noop)
      await vi.advanceTimersByTimeAsync(10)
      await expect(missing).rejects.toBeInstanceOf(NotFoundError)
      await vi.advanceTimersByTimeAsync(30)
    })

    it('should start a dependent query in a second load, once the first has the data it needs', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const { postQuery, authorPostsQuery, viewerQuery, fetchAuthorPosts } =
        createBlog()

      const loader = async (params: { id: string }) => {
        const first = await experimental_loadQueryHandles(queryClient, {
          viewer: experimental_prefetchEntry(viewerQuery),
          post: experimental_fetchEntry(postQuery, params),
        })
        // Untagged keys type the data as unknown
        const post = first.data.post as Post | null
        if (!post) throw new Error('not found')
        const second = await experimental_loadQueryHandles(queryClient, {
          authorPosts: experimental_prefetchEntry(authorPostsQuery, {
            authorId: post.authorId,
          }),
        })
        return { ...first.handles, ...second.handles }
      }

      const promise = loader({ id: '1' })
      expect(fetchAuthorPosts).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      const handles = await promise

      expect(fetchAuthorPosts).toHaveBeenCalledWith('a')
      expect(handles.authorPosts).toStrictEqual({
        queryKey: authorPostsQuery({ authorId: 'a' }).queryKey,
        input: { authorId: 'a' },
      })
      expect(
        queryClient.getQueryState(viewerQuery().queryKey)?.fetchStatus,
      ).toBe('fetching')
      await vi.advanceTimersByTimeAsync(20)
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

      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(queryFn).toHaveBeenCalledTimes(1)

      // staleTime defaults to 0, so the data is already stale
      await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      expect(queryFn).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)

      const fetched = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
      expect(queryFn).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(10)
      await expect(fetched).resolves.toMatchObject({ data: { post: '1' } })
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

      const first = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)
      await first
      await experimental_loadQueryHandles(queryClient, {
        prefetched: experimental_prefetchEntry(postQuery, { id: '1' }),
        fetched: experimental_fetchEntry(postQuery, { id: '1' }),
      })

      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('experimental_fromHandle', () => {
    it("should rebuild the factory's options for the handle's input", async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const { handles } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })

      const options = experimental_fromHandle(postQuery, handles.post)

      expect(options).toStrictEqual({
        ...postQuery({ id: '1' }),
        queryFn: expect.any(Function),
      })
      expect(options).not.toHaveProperty('initialData')
      await vi.advanceTimersByTimeAsync(10)
    })

    it('should take read-site options spread over it', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const { handles } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })
      await vi.advanceTimersByTimeAsync(10)

      const observer = new QueryObserver(queryClient, {
        ...experimental_fromHandle(postQuery, handles.post),
        select: (data) => String(data).length,
      })

      expect(observer.getCurrentResult().data).toBe(1)
    })

    it('should add no initialData for a fetched handle', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const postQuery = createPostQuery()
      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
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
      const promise = experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })
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

    it('should return the same handle while the new input maps to its query', async () => {
      using _timers = fakeTimers()
      using queryClient = clearOnDispose(new QueryClient())
      const key = createKey()
      const postQuery = (input: { id: string; locale?: string }) => ({
        queryKey: [...key, input.id],
        queryFn: () => input.id,
      })
      const {
        handles: { post: previous },
      } = await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
      })

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
