import { assertType, describe, expectTypeOf, it } from 'vitest'
import {
  QueryClient,
  experimental_ensureEntry,
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
import type {
  InfiniteData,
  experimental_DefinedQueryHandle,
  experimental_InferQueryHandleData,
  experimental_LoadedQueryHandles,
  experimental_QueryHandle,
  experimental_QueryHandleEntry,
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
  describe('entries', () => {
    it("should take the factory's input", () => {
      assertType(experimental_prefetchEntry(postQuery, { id: '1' }))
      assertType(experimental_fetchEntry(viewerQuery))

      // @ts-expect-error the input is required
      assertType(experimental_prefetchEntry(postQuery))
      assertType(
        // @ts-expect-error the input has the wrong shape
        experimental_fetchEntry(postQuery, { id: 1 }),
      )
      assertType(
        // @ts-expect-error the factory takes no input
        experimental_prefetchEntry(viewerQuery, { id: '1' }),
      )
      assertType(
        // @ts-expect-error the input has the wrong shape
        experimental_ensureEntry(postQuery, { id: 1 }),
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

      assertType(experimental_prefetchEntry(optionsQuery, { id: '1' }))
      assertType(
        experimental_prefetchEntry(
          optionsQuery,
          { id: '1' },
          // @ts-expect-error the handle only carries the input
          { staleTime: 60_000 },
        ),
      )
      assertType(
        experimental_fetchEntry(
          optionsQuery,
          { id: '1' },
          // @ts-expect-error the handle only carries the input
          { staleTime: 60_000 },
        ),
      )
      assertType(
        experimental_ensureEntry(
          optionsQuery,
          { id: '1' },
          // @ts-expect-error the handle only carries the input
          { staleTime: 60_000 },
        ),
      )
    })

    it('should take an optional input', async () => {
      const listQuery = (input?: { page: number }) =>
        queryOptions({
          queryKey: ['list', input?.page ?? 1] as const,
          queryFn: () => Promise.resolve([input?.page ?? 1]),
        })

      assertType(experimental_prefetchEntry(listQuery))
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        list: experimental_prefetchEntry(listQuery, { page: 2 }),
      })

      expectTypeOf(handles.list.input).toEqualTypeOf<
        { page: number } | undefined
      >()
    })

    it('should not be handles', () => {
      const entry = experimental_fetchEntry(postQuery, { id: '1' })

      // @ts-expect-error an entry is not a handle
      assertType(experimental_fromHandle(postQuery, entry))
    })
  })

  describe('experimental_loadQueryHandles', () => {
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
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        page: experimental_prefetchEntry(pageQuery, { id: '1' }),
      })

      expectTypeOf(handles.page.queryKey).toEqualTypeOf<
        readonly [string, string, (number | undefined)?]
      >()
    })

    it('should resolve to a readonly [handles, data] tuple', async () => {
      const loaded = await experimental_loadQueryHandles(queryClient, {
        post: experimental_fetchEntry(postQuery, { id: '1' }),
      })

      expectTypeOf(loaded).toEqualTypeOf<
        readonly [
          handles: { post: experimental_DefinedQueryHandle<typeof postQuery> },
          data: { post: Post },
        ]
      >()
      expectTypeOf(loaded).toEqualTypeOf<
        experimental_LoadedQueryHandles<{
          post: experimental_QueryHandleEntry<typeof postQuery, 'fetch'>
        }>
      >()
      // @ts-expect-error the tuple is readonly
      loaded[0] = loaded[0]
    })

    it('should return plain handles with the key and input', async () => {
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        post: experimental_prefetchEntry(postQuery, { id: '1' }),
        viewer: experimental_prefetchEntry(viewerQuery),
      })

      expectTypeOf(handles.post.queryKey).toEqualTypeOf<
        readonly ['post', string]
      >()
      expectTypeOf(handles.post.input).toEqualTypeOf<{ id: string }>()
      expectTypeOf(handles.viewer.input).toEqualTypeOf<undefined>()
      expectTypeOf(handles.post).not.toHaveProperty('data')
    })

    it('should give fetch and ensure entries defined handles, and prefetch entries plain ones', async () => {
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        prefetched: experimental_prefetchEntry(postQuery, { id: '1' }),
        fetched: experimental_fetchEntry(postQuery, { id: '1' }),
        ensured: experimental_ensureEntry(viewerQuery),
      })

      expectTypeOf(handles.prefetched).toEqualTypeOf<
        experimental_QueryHandle<typeof postQuery>
      >()
      expectTypeOf(handles.fetched).toEqualTypeOf<
        experimental_DefinedQueryHandle<typeof postQuery>
      >()
      expectTypeOf(handles.ensured).toEqualTypeOf<
        experimental_DefinedQueryHandle<typeof viewerQuery>
      >()
      expectTypeOf(handles.fetched).toExtend<
        experimental_QueryHandle<typeof postQuery>
      >()
      expectTypeOf(handles.prefetched).not.toExtend<
        experimental_DefinedQueryHandle<typeof postQuery>
      >()
    })

    it('should give the data of fetch and ensure entries only', async () => {
      const [, data] = await experimental_loadQueryHandles(queryClient, {
        prefetched: experimental_prefetchEntry(postQuery, { id: '1' }),
        fetched: experimental_fetchEntry(postQuery, { id: '1' }),
        ensured: experimental_ensureEntry(viewerQuery),
      })

      expectTypeOf(data).toEqualTypeOf<{
        fetched: Post
        ensured: { name: string }
      }>()
    })

    it("should give what a factory's select returns, and InfiniteData for an infinite factory", async () => {
      const postTitleQuery = (input: { id: string }) =>
        queryOptions({
          queryKey: ['post-title', input.id] as const,
          queryFn: (): Promise<Post> =>
            Promise.resolve({ id: input.id, title: '' }),
          select: (post) => post.title,
        })
      const [handles, data] = await experimental_loadQueryHandles(queryClient, {
        title: experimental_fetchEntry(postTitleQuery, { id: '1' }),
        feed: experimental_ensureEntry(feedQuery, { size: 1 }),
      })

      expectTypeOf(data.title).toEqualTypeOf<string>()
      expectTypeOf(data.feed).toEqualTypeOf<
        InfiniteData<Array<number>, unknown>
      >()
      expectTypeOf<
        experimental_InferQueryHandleData<typeof handles.title>
      >().toEqualTypeOf<string>()
    })

    it('should take only entries', () => {
      assertType(
        experimental_loadQueryHandles(queryClient, {
          // @ts-expect-error a handle is not an entry
          post: {} as experimental_QueryHandle<typeof postQuery>,
        }),
      )
      assertType(
        experimental_loadQueryHandles(queryClient, {
          // @ts-expect-error a factory is not an entry
          post: postQuery,
        }),
      )
    })
  })

  describe('experimental_fromHandle', () => {
    it('should type useQuery data as possibly undefined for every handle', async () => {
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        prefetched: experimental_prefetchEntry(postQuery, { id: '1' }),
        fetched: experimental_fetchEntry(postQuery, { id: '1' }),
        ensured: experimental_ensureEntry(postQuery, { id: '1' }),
      })

      expectTypeOf(
        useQuery(experimental_fromHandle(postQuery, handles.prefetched)).data,
      ).toEqualTypeOf<Post | undefined>()
      expectTypeOf(
        useQuery(experimental_fromHandle(postQuery, handles.fetched)).data,
      ).toEqualTypeOf<Post | undefined>()
      expectTypeOf(
        useQuery(experimental_fromHandle(postQuery, handles.ensured)).data,
      ).toEqualTypeOf<Post | undefined>()
    })

    it('should type useSuspenseQuery data as defined for every handle', async () => {
      const [handles] = await experimental_loadQueryHandles(queryClient, {
        prefetched: experimental_prefetchEntry(postQuery, { id: '1' }),
        fetched: experimental_fetchEntry(postQuery, { id: '1' }),
        ensured: experimental_ensureEntry(postQuery, { id: '1' }),
      })

      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postQuery, handles.prefetched))
          .data,
      ).toEqualTypeOf<Post>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postQuery, handles.fetched))
          .data,
      ).toEqualTypeOf<Post>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postQuery, handles.ensured))
          .data,
      ).toEqualTypeOf<Post>()
    })

    it('should keep useQuery data possibly undefined when read-site options are spread', async () => {
      const handle = (
        await experimental_loadQueryHandles(queryClient, {
          handle: experimental_fetchEntry(postQuery, {
            id: '1',
          }),
        })
      )[0].handle

      const { data } = useQuery({
        ...experimental_fromHandle(postQuery, handle),
        select: (post) => post.title,
      })

      expectTypeOf(data).toEqualTypeOf<string | undefined>()
    })

    it('should accept keepPreviousData as placeholderData', () => {
      const handle = {} as experimental_QueryHandle<typeof postQuery>

      const { data } = useQuery({
        ...experimental_fromHandle(postQuery, handle),
        placeholderData: keepPreviousData,
      })

      expectTypeOf(data).toEqualTypeOf<Post | undefined>()
    })

    it("should accept keepPreviousData for an infinite factory called with a handle's input", () => {
      const handle = {} as experimental_QueryHandle<typeof feedQuery>

      const { data } = useInfiniteQuery({
        ...feedQuery({ ...handle.input, size: 2 }),
        placeholderData: keepPreviousData,
      })

      expectTypeOf(data).toEqualTypeOf<
        InfiniteData<Array<number>, unknown> | undefined
      >()
    })

    it('should work with infinite queries', () => {
      const handle = {} as experimental_QueryHandle<typeof feedQuery>

      const { data } = useSuspenseInfiniteQuery(
        experimental_fromHandle(feedQuery, handle),
      )

      expectTypeOf(data).toEqualTypeOf<InfiniteData<Array<number>, unknown>>()
    })

    it('should type infinite data as possibly undefined for useInfiniteQuery and defined for useSuspenseInfiniteQuery', async () => {
      const handle = (
        await experimental_loadQueryHandles(queryClient, {
          handle: experimental_fetchEntry(feedQuery, { size: 1 }),
        })
      )[0].handle

      expectTypeOf(
        useInfiniteQuery(experimental_fromHandle(feedQuery, handle)).data,
      ).toEqualTypeOf<InfiniteData<Array<number>, unknown> | undefined>()
      expectTypeOf(
        useSuspenseInfiniteQuery(experimental_fromHandle(feedQuery, handle))
          .data,
      ).toEqualTypeOf<InfiniteData<Array<number>, unknown>>()
    })

    it('should take no third argument', () => {
      const handle = {} as experimental_QueryHandle<typeof postQuery>

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
      const handle = {} as experimental_QueryHandle<typeof otherQuery>

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
      const handle = {} as experimental_QueryHandle<typeof postQuery>

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
      const handle = {} as experimental_QueryHandle<typeof postQuery>

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
      const handle = {} as experimental_QueryHandle<typeof postQuery>

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
      const handle = {} as experimental_QueryHandle<typeof feedQuery>

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
      const handle = {} as experimental_QueryHandle<typeof postTitleQuery>
      const awaited = (
        await experimental_loadQueryHandles(queryClient, {
          handle: experimental_fetchEntry(postTitleQuery, { id: '1' }),
        })
      )[0].handle

      expectTypeOf(
        useQuery(experimental_fromHandle(postTitleQuery, handle)).data,
      ).toEqualTypeOf<string | undefined>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postTitleQuery, awaited)).data,
      ).toEqualTypeOf<string>()
      expectTypeOf(
        useSuspenseQuery(experimental_fromHandle(postTitleQuery, handle)).data,
      ).toEqualTypeOf<string>()
    })

    it("should keep a selecting factory's cache data as the queryFn's data", async () => {
      const handle = (
        await experimental_loadQueryHandles(queryClient, {
          handle: experimental_fetchEntry(postTitleQuery, { id: '1' }),
        })
      )[0].handle

      expectTypeOf(handle).toEqualTypeOf<
        experimental_DefinedQueryHandle<typeof postTitleQuery>
      >()
      expectTypeOf(handle.queryKey).toEqualTypeOf<
        readonly ['post-title', string]
      >()
      expectTypeOf(
        queryClient.getQueryData(postTitleQuery({ id: '1' }).queryKey),
      ).toEqualTypeOf<Post | undefined>()
    })

    it("should type data from an infinite factory's select", () => {
      const handle = {} as experimental_QueryHandle<typeof feedItemsQuery>

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
      const handle = {} as experimental_QueryHandle<typeof postTitleQuery>

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
      const awaited = (
        await experimental_loadQueryHandles(queryClient, {
          handle: experimental_fetchEntry(postTitleQuery, { id: '1' }),
        })
      )[0].handle

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
