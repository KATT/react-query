import { assertType, describe, expectTypeOf, it } from 'vitest'
import {
  QueryClient,
  experimental_fromHandle,
  experimental_loadQueryHandles,
  experimental_waterfallHandle,
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import type {
  InfiniteData,
  experimental_InferQueryHandleData,
  experimental_QueryHandle,
  experimental_QueryHandleLoader,
} from '..'

type Post = { id: string; title: string }

const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: (): Promise<Post> => Promise.resolve({ id: input.id, title: '' }),
  })

const viewerQuery = () =>
  queryOptions({
    queryKey: ['viewer'] as const,
    queryFn: () => Promise.resolve({ name: 'viewer' }),
  })

const feedQuery = (input: { size: number }) =>
  infiniteQueryOptions({
    queryKey: ['feed', input.size] as const,
    queryFn: ({ pageParam }) => Promise.resolve([pageParam]),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage[0],
  })

const queryClient = new QueryClient()

describe('query handles', () => {
  describe('experimental_loadQueryHandles', () => {
    it("should take the factory's input", () => {
      assertType(
        experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.start(postQuery, { id: '1' }),
          viewer: load.wait(viewerQuery),
          // @ts-expect-error the input is required
          missing: load.start(postQuery),
          // @ts-expect-error the input has the wrong shape
          wrong: load.wait(postQuery, { id: 1 }),
          // @ts-expect-error the factory takes no input
          extra: load.start(viewerQuery, { id: '1' }),
          // @ts-expect-error the input has the wrong shape
          ensured: load.ensure(postQuery, { id: 1 }),
        })),
      )
    })

    it("should not take a factory's other parameters, which the handle can't carry", () => {
      const optionsQuery = (
        input: { id: string },
        opts?: { staleTime?: number },
      ) =>
        queryOptions({
          queryKey: ['post', input.id] as const,
          queryFn: () => Promise.resolve(input.id),
          staleTime: opts?.staleTime,
        })

      assertType(
        experimental_loadQueryHandles(queryClient, (load) => ({
          post: load.start(optionsQuery, { id: '1' }),
          // @ts-expect-error the handle only carries the input
          waited: load.wait(optionsQuery, { id: '1' }, { staleTime: 60_000 }),
        })),
      )
      const opts = { staleTime: 60_000 }
      // @ts-expect-error the handle only carries the input
      assertType(experimental_waterfallHandle(optionsQuery, { id: '1' }, opts))
    })

    it('should take pages only for an infinite factory', () => {
      const feedlessQuery = () =>
        infiniteQueryOptions({
          queryKey: ['feedless'] as const,
          queryFn: ({ pageParam }) => Promise.resolve([pageParam]),
          initialPageParam: 0,
          getNextPageParam: (lastPage) => lastPage[0],
        })

      assertType(
        experimental_loadQueryHandles(queryClient, (load) => ({
          feed: load.wait(feedQuery, { size: 1 }, { pages: 2 }),
          feedless: load.ensure(feedlessQuery, undefined, { pages: 2 }),
          started: load.start(feedQuery, { size: 1 }),
          // @ts-expect-error a query has no pages
          post: load.wait(postQuery, { id: '1' }, { pages: 2 }),
        })),
      )
    })

    it('should take an optional input', async () => {
      const listQuery = (input?: { page: number }) =>
        queryOptions({
          queryKey: ['list', input?.page ?? 1] as const,
          queryFn: () => Promise.resolve([input?.page ?? 1]),
        })

      const { handles } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({
          first: load.start(listQuery),
          second: load.start(listQuery, { page: 2 }),
        }),
      )

      expectTypeOf(handles.second.input).toEqualTypeOf<
        { page: number } | undefined
      >()
    })

    it('should keep optional key elements and drop the data tag', async () => {
      const pageQuery = (input: { id: string; page?: number }) =>
        queryOptions({
          queryKey: (input.page === undefined
            ? ['page', input.id]
            : ['page', input.id, input.page]) as readonly [
            string,
            string,
            number?,
          ],
          queryFn: () => Promise.resolve(input.id),
        })

      const { handles } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({ page: load.start(pageQuery, { id: '1' }) }),
      )

      expectTypeOf(handles.page.queryKey).toEqualTypeOf<
        readonly [string, string, (number | undefined)?]
      >()
    })

    it('should type a plain handle per query and data per waited query', async () => {
      const { handles, data } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({
          viewer: load.start(viewerQuery),
          post: load.wait(postQuery, { id: '1' }),
          feed: load.ensure(feedQuery, { size: 10 }),
        }),
      )

      expectTypeOf(handles.viewer).toEqualTypeOf<
        experimental_QueryHandle<typeof viewerQuery>
      >()
      expectTypeOf(handles.viewer.input).toEqualTypeOf<undefined>()
      expectTypeOf(handles.post).toEqualTypeOf<
        experimental_QueryHandle<typeof postQuery>
      >()
      expectTypeOf(handles.post.queryKey).toEqualTypeOf<
        readonly ['post', string]
      >()
      expectTypeOf(handles.post.input).toEqualTypeOf<{ id: string }>()
      expectTypeOf(handles.post).not.toHaveProperty('data')
      expectTypeOf(data).toEqualTypeOf<{
        post: Post
        feed: InfiniteData<Array<number>, unknown>
      }>()
      // @ts-expect-error a started query has no data
      assertType(data.viewer)
    })

    it("should type data from a factory's select", async () => {
      const postTitleQuery = (input: { id: string }) =>
        queryOptions({
          queryKey: ['post-title', input.id] as const,
          queryFn: (): Promise<Post> =>
            Promise.resolve({ id: input.id, title: '' }),
          select: (post) => post.title,
        })

      const { handles, data } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({ title: load.wait(postTitleQuery, { id: '1' }) }),
      )

      expectTypeOf(data.title).toEqualTypeOf<string>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof handles.title>
      >().toEqualTypeOf<string>()
    })

    it('should not take a callback that returns a promise, or values that are not queries', () => {
      const asyncCallback = (load: experimental_QueryHandleLoader) =>
        Promise.resolve({ post: load.wait(postQuery, { id: '1' }) })

      // @ts-expect-error the callback can't return a promise
      assertType(experimental_loadQueryHandles(queryClient, asyncCallback))
      assertType(
        experimental_loadQueryHandles(queryClient, () => ({
          // @ts-expect-error only queries go in the result
          post: experimental_waterfallHandle(postQuery, { id: '1' }),
        })),
      )
    })

    it("should pass a dependent query its parent's data and type a nullable result", async () => {
      type AuthoredPost = { id: string; authorId: string | null }
      const authoredPostQuery = (input: { id: string }) =>
        queryOptions({
          queryKey: ['authored-post', input.id] as const,
          queryFn: (): Promise<AuthoredPost | null> => Promise.resolve(null),
        })
      const authorPostsQuery = (input: { authorId: string }) =>
        queryOptions({
          queryKey: ['author-posts', input.authorId] as const,
          queryFn: () => Promise.resolve([{ id: '2' }]),
        })

      const { handles, data } = await experimental_loadQueryHandles(
        queryClient,
        (load) => {
          const post = load.wait(authoredPostQuery, { id: '1' })
          return {
            post,
            morePosts: load.after(post, (value) => {
              expectTypeOf(value).toEqualTypeOf<AuthoredPost | null>()
              return value?.authorId
                ? load.wait(authorPostsQuery, { authorId: value.authorId })
                : null
            }),
            viewer: load.after(post, () => load.start(viewerQuery)),
          }
        },
      )

      expectTypeOf(handles.morePosts).toEqualTypeOf<experimental_QueryHandle<
        typeof authorPostsQuery
      > | null>()
      expectTypeOf(data.morePosts).toEqualTypeOf<Array<{
        id: string
      }> | null>()
      expectTypeOf(handles.viewer).toEqualTypeOf<
        experimental_QueryHandle<typeof viewerQuery>
      >()
      expectTypeOf(data).not.toHaveProperty('viewer')
    })

    it('should only take a waited query as a parent', () => {
      assertType(
        experimental_loadQueryHandles(queryClient, (load) => {
          const viewer = load.start(viewerQuery)
          return {
            // @ts-expect-error a started query has no data to wait for
            post: load.after(viewer, () => load.start(postQuery, { id: '1' })),
          }
        }),
      )
    })
  })

  describe('experimental_fromHandle', () => {
    it('should type useQuery data as possibly undefined for every handle', async () => {
      const { handles } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({
          started: load.start(postQuery, { id: '1' }),
          waited: load.wait(postQuery, { id: '1' }),
          ensured: load.ensure(postQuery, { id: '1' }),
        }),
      )
      const waterfall = experimental_waterfallHandle(postQuery, { id: '1' })

      for (const handle of [...Object.values(handles), waterfall]) {
        expectTypeOf(
          useQuery(experimental_fromHandle(postQuery, handle)).data,
        ).toEqualTypeOf<Post | undefined>()
      }
    })
    it('should type useSuspenseQuery data as defined for every handle', async () => {
      const { handles } = await experimental_loadQueryHandles(
        queryClient,
        (load) => ({
          started: load.start(postQuery, { id: '1' }),
          waited: load.wait(postQuery, { id: '1' }),
          ensured: load.ensure(postQuery, { id: '1' }),
        }),
      )
      const waterfall = experimental_waterfallHandle(postQuery, { id: '1' })

      for (const handle of [...Object.values(handles), waterfall]) {
        expectTypeOf(
          useSuspenseQuery(experimental_fromHandle(postQuery, handle)).data,
        ).toEqualTypeOf<Post>()
      }
    })
    it('should keep useQuery data possibly undefined when read-site options are spread', async () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      const { data } = useQuery({
        ...experimental_fromHandle(postQuery, handle),
        select: (post) => post.title,
      })

      expectTypeOf(data).toEqualTypeOf<string | undefined>()
    })

    it('should accept keepPreviousData as placeholderData', () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      const { data } = useQuery({
        ...experimental_fromHandle(postQuery, handle),
        placeholderData: keepPreviousData,
      })

      expectTypeOf(data).toEqualTypeOf<Post | undefined>()
    })

    it('should work with infinite queries', () => {
      const handle = experimental_waterfallHandle(feedQuery, {
        size: 1,
      })

      const { data } = useSuspenseInfiniteQuery(
        experimental_fromHandle(feedQuery, handle),
      )

      expectTypeOf(data).toEqualTypeOf<InfiniteData<Array<number>, unknown>>()
    })

    it('should type infinite data as possibly undefined for useInfiniteQuery and defined for useSuspenseInfiniteQuery', async () => {
      const handle = experimental_waterfallHandle(feedQuery, { size: 1 })

      expectTypeOf(
        useInfiniteQuery(experimental_fromHandle(feedQuery, handle)).data,
      ).toEqualTypeOf<InfiniteData<Array<number>, unknown> | undefined>()
      expectTypeOf(
        useSuspenseInfiniteQuery(experimental_fromHandle(feedQuery, handle))
          .data,
      ).toEqualTypeOf<InfiniteData<Array<number>, unknown>>()
    })

    it('should take no third argument', () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      assertType(
        // @ts-expect-error read-site options are spread over the result instead
        experimental_fromHandle(postQuery, handle, { enabled: false }),
      )
    })

    it("should not accept another factory's handle", () => {
      const otherQuery = (input: { id: string }) =>
        queryOptions({
          queryKey: ['other', input.id] as const,
          queryFn: (): Promise<Post> =>
            Promise.resolve({ id: input.id, title: '' }),
        })
      const handle = experimental_waterfallHandle(otherQuery, {
        id: '1',
      })

      // @ts-expect-error the keys differ
      assertType(experimental_fromHandle(postQuery, handle))
    })

    it('should accept handles typed by their factory', () => {
      const handle = {} as experimental_QueryHandle<typeof postQuery>

      expectTypeOf(
        useQuery(experimental_fromHandle(postQuery, handle)).data,
      ).toEqualTypeOf<Post | undefined>()
    })
  })

  describe('experimental_waterfallHandle', () => {
    it("should take the factory's input", () => {
      const handle = experimental_waterfallHandle(postQuery, { id: '1' })
      const viewer = experimental_waterfallHandle(viewerQuery)

      expectTypeOf(handle).toEqualTypeOf<
        experimental_QueryHandle<typeof postQuery>
      >()
      expectTypeOf(viewer.input).toEqualTypeOf<undefined>()
      // @ts-expect-error the input has the wrong shape
      experimental_waterfallHandle(postQuery, { id: 1 })
    })

    it('should switch a handle to a new input', () => {
      const handle = {} as experimental_QueryHandle<typeof postQuery>

      const next = experimental_waterfallHandle(postQuery, handle, (input) => {
        expectTypeOf(input).toEqualTypeOf<{ id: string }>()
        return { ...input, id: '2' }
      })

      expectTypeOf(next).toEqualTypeOf<
        experimental_QueryHandle<typeof postQuery>
      >()
      experimental_waterfallHandle(
        postQuery,
        handle,
        // @ts-expect-error the new input has the wrong shape
        () => ({ id: 2 }),
      )
    })
  })

  describe('select', () => {
    const postTitleQuery = (input: { id: string }) =>
      queryOptions({
        queryKey: ['post-title', input.id] as const,
        queryFn: (): Promise<Post> =>
          Promise.resolve({ id: input.id, title: '' }),
        select: (post) => post.title,
      })

    const feedItemsQuery = (input: { size: number }) =>
      infiniteQueryOptions({
        queryKey: ['feed-items', input.size] as const,
        queryFn: ({ pageParam }) => Promise.resolve([pageParam]),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => lastPage[0],
        select: (data) => data.pages.flat(),
      })

    it('should infer a read-site select from the factory with useQuery', () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      const { data } = useQuery({
        ...experimental_fromHandle(postQuery, handle),
        select: (post) => {
          expectTypeOf(post).toEqualTypeOf<Post>()
          return post.title
        },
        placeholderData: (previous) => {
          expectTypeOf(previous).toEqualTypeOf<Post | undefined>()
          return previous
        },
        enabled: (query) => {
          expectTypeOf(query.state.data).toEqualTypeOf<Post | undefined>()
          return true
        },
      })

      expectTypeOf(data).toEqualTypeOf<string | undefined>()
    })

    it('should infer a read-site select from the factory with useSuspenseQuery', () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      const { data } = useSuspenseQuery({
        ...experimental_fromHandle(postQuery, handle),
        select: (post) => {
          expectTypeOf(post).toEqualTypeOf<Post>()
          return post.title
        },
      })

      expectTypeOf(data).toEqualTypeOf<string>()
    })

    it('should type read-site placeholderData and enabled from the factory', () => {
      const handle = experimental_waterfallHandle(postQuery, {
        id: '1',
      })

      assertType(
        useQuery({
          ...experimental_fromHandle(postQuery, handle),
          placeholderData: { id: '1', title: '' },
          enabled: false,
        }),
      )
      assertType(
        useQuery({
          ...experimental_fromHandle(postQuery, handle),
          // @ts-expect-error placeholderData has the query's data type
          placeholderData: 'title',
        }),
      )
      assertType(
        useQuery({
          ...experimental_fromHandle(postQuery, handle),
          // @ts-expect-error enabled is a boolean or a function of the query
          enabled: 'yes',
        }),
      )
    })

    it('should infer a read-site select from an infinite factory', () => {
      const handle = experimental_waterfallHandle(feedQuery, {
        size: 1,
      })

      const { data } = useInfiniteQuery({
        ...experimental_fromHandle(feedQuery, handle),
        select: (feed) => {
          expectTypeOf(feed).toEqualTypeOf<
            InfiniteData<Array<number>, number>
          >()
          return feed.pages.flat()
        },
      })
      const suspense = useSuspenseInfiniteQuery({
        ...experimental_fromHandle(feedQuery, handle),
        select: (feed) => feed.pages.flat(),
      })

      expectTypeOf(data).toEqualTypeOf<Array<number> | undefined>()
      expectTypeOf(suspense.data).toEqualTypeOf<Array<number>>()
    })

    it("should type data from a factory's select", async () => {
      const started = experimental_waterfallHandle(postTitleQuery, {
        id: '1',
      })
      const awaited = experimental_waterfallHandle(postTitleQuery, { id: '1' })
      const waterfall = experimental_waterfallHandle(postTitleQuery, {
        id: '1',
      })

      expectTypeOf(
        useQuery(experimental_fromHandle(postTitleQuery, started)).data,
      ).toEqualTypeOf<string | undefined>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postTitleQuery, awaited)).data,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postTitleQuery, waterfall))
          .data,
      ).toEqualTypeOf<string>()
    })

    it("should keep a selecting factory's cache data as the queryFn's data", async () => {
      const handle = experimental_waterfallHandle(postTitleQuery, { id: '1' })

      expectTypeOf(handle).toEqualTypeOf<
        experimental_QueryHandle<typeof postTitleQuery>
      >()
      expectTypeOf(handle.queryKey).toEqualTypeOf<
        readonly ['post-title', string]
      >()
      expectTypeOf(
        queryClient.getQueryData(postTitleQuery({ id: '1' }).queryKey),
      ).toEqualTypeOf<Post | undefined>()
    })

    it("should type data from an infinite factory's select", () => {
      const handle = experimental_waterfallHandle(feedItemsQuery, {
        size: 1,
      })

      expectTypeOf(
        useInfiniteQuery(experimental_fromHandle(feedItemsQuery, handle)).data,
      ).toEqualTypeOf<Array<number> | undefined>()
      expectTypeOf(
        useSuspenseInfiniteQuery(
          experimental_fromHandle(feedItemsQuery, handle),
        ).data,
      ).toEqualTypeOf<Array<number>>()
    })

    it("should replace a factory's select with a read-site select over the queryFn's data", () => {
      const handle = experimental_waterfallHandle(postTitleQuery, {
        id: '1',
      })

      const { data } = useSuspenseQuery({
        ...experimental_fromHandle(postTitleQuery, handle),
        select: (post) => {
          expectTypeOf(post).toEqualTypeOf<Post>()
          return post.id.length
        },
      })

      expectTypeOf(data).toEqualTypeOf<number>()
    })
  })

  describe('experimental_InferQueryHandleData', () => {
    const postTitleQuery = (input: { id: string }) =>
      queryOptions({
        queryKey: ['post-title', input.id] as const,
        queryFn: (): Promise<Post> =>
          Promise.resolve({ id: input.id, title: '' }),
        select: (post) => post.title,
      })

    const feedItemsQuery = (input: { size: number }) =>
      infiniteQueryOptions({
        queryKey: ['feed-items', input.size] as const,
        queryFn: ({ pageParam }) => Promise.resolve([pageParam]),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => lastPage[0],
        select: (data) => data.pages.flat(),
      })

    const handle = {} as experimental_QueryHandle<typeof postQuery>

    it("should give a factory's data, the same as useSuspenseQuery", () => {
      expectTypeOf<
        experimental_InferQueryHandleData<typeof postQuery>
      >().toEqualTypeOf<Post>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof viewerQuery>
      >().toEqualTypeOf<{ name: string }>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof postQuery>
      >().toEqualTypeOf(
        useSuspenseQuery(experimental_fromHandle(postQuery, handle)).data,
      )
    })

    it("should give what a factory's select returns, the same as useSuspenseQuery", () => {
      const titleHandle = {} as experimental_QueryHandle<typeof postTitleQuery>

      expectTypeOf<
        experimental_InferQueryHandleData<typeof postTitleQuery>
      >().toEqualTypeOf<string>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof postTitleQuery>
      >().toEqualTypeOf(
        useSuspenseQuery(experimental_fromHandle(postTitleQuery, titleHandle))
          .data,
      )
    })

    it("should give an infinite factory's data, the same as useSuspenseInfiniteQuery", () => {
      const feedHandle = {} as experimental_QueryHandle<typeof feedQuery>

      expectTypeOf<
        experimental_InferQueryHandleData<typeof feedQuery>
      >().toEqualTypeOf<InfiniteData<Array<number>, unknown>>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof feedQuery>
      >().toEqualTypeOf(
        useSuspenseInfiniteQuery(experimental_fromHandle(feedQuery, feedHandle))
          .data,
      )
    })

    it("should give what an infinite factory's select returns, the same as useSuspenseInfiniteQuery", () => {
      const itemsHandle = {} as experimental_QueryHandle<typeof feedItemsQuery>

      expectTypeOf<
        experimental_InferQueryHandleData<typeof feedItemsQuery>
      >().toEqualTypeOf<Array<number>>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof feedItemsQuery>
      >().toEqualTypeOf(
        useSuspenseInfiniteQuery(
          experimental_fromHandle(feedItemsQuery, itemsHandle),
        ).data,
      )
    })

    it('should take a handle type', async () => {
      const awaited = experimental_waterfallHandle(postTitleQuery, { id: '1' })

      expectTypeOf<
        experimental_InferQueryHandleData<typeof handle>
      >().toEqualTypeOf<Post>()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof awaited>
      >().toEqualTypeOf<string>()
    })

    it('should type a prop that takes the data', () => {
      function PostTitle(props: {
        post: experimental_InferQueryHandleData<typeof postQuery>
      }) {
        return props.post.title
      }
      const { data } = useSuspenseQuery(
        experimental_fromHandle(postQuery, handle),
      )
      const maybe = useQuery(experimental_fromHandle(postQuery, handle)).data

      assertType(PostTitle({ post: data }))
      // @ts-expect-error useQuery data may be undefined
      assertType(PostTitle({ post: maybe }))
    })
  })
})
