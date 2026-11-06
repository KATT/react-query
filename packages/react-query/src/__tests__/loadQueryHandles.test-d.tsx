import { assertType, describe, expectTypeOf, it } from 'vitest'
import {
  QueryClient,
  experimental_fromHandle,
  experimental_getQueryHandleData,
  experimental_loadQueryHandles,
  infiniteQueryOptions,
  queryOptions,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import type {
  InfiniteData,
  experimental_DefinedQueryHandle,
  experimental_QueryHandle,
} from '..'

type Post = { id: string; authorId: string | null }

const postQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['post', input.id] as const,
    queryFn: (): Promise<Post | null> => Promise.resolve(null),
  })

const viewerQuery = () =>
  queryOptions({
    queryKey: ['viewer'] as const,
    queryFn: () => Promise.resolve({ name: 'viewer' }),
  })

const userQuery = (input: { id: string }) =>
  queryOptions({
    queryKey: ['user', input.id] as const,
    queryFn: () => Promise.resolve({ name: input.id }),
  })

const feedQuery = (input: { size: number }) =>
  infiniteQueryOptions({
    queryKey: ['feed', input.size] as const,
    queryFn: ({ pageParam }) => Promise.resolve([pageParam]),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage[0],
  })

const queryClient = new QueryClient()

describe('experimental_loadQueryHandles', () => {
  it('should type a handle per entry and data per waited entry', async () => {
    const { handles, data } = await experimental_loadQueryHandles(
      queryClient,
      (q) => ({
        viewer: q.start(viewerQuery),
        post: q.wait(postQuery, { id: '1' }),
        feed: q.ensure(feedQuery, { size: 10 }),
      }),
    )

    expectTypeOf(handles.viewer).toEqualTypeOf<
      experimental_QueryHandle<typeof viewerQuery>
    >()
    expectTypeOf(handles.post).toEqualTypeOf<
      experimental_DefinedQueryHandle<typeof postQuery>
    >()
    expectTypeOf(data).toEqualTypeOf<{
      post: Post | null
      feed: InfiniteData<Array<number>, unknown>
    }>()
    // @ts-expect-error a started entry has no data
    assertType(data.viewer)
  })

  it('should take the same inputs as the verbs', () => {
    assertType(
      experimental_loadQueryHandles(queryClient, (q) => ({
        // @ts-expect-error the input is required
        post: q.wait(postQuery),
        // @ts-expect-error the factory takes no input
        viewer: q.start(viewerQuery, { id: '1' }),
        // @ts-expect-error the input has the wrong shape
        user: q.ensure(userQuery, { id: 1 }),
      })),
    )
  })

  it('should not take a callback that returns a promise or values that are not entries', () => {
    assertType(
      experimental_loadQueryHandles(
        queryClient,
        // @ts-expect-error the callback can't return a promise
        (q) => Promise.resolve({ post: q.wait(postQuery, { id: '1' }) }),
      ),
    )
    assertType(
      experimental_loadQueryHandles(queryClient, () => ({
        // @ts-expect-error only entries go in the result
        post: experimental_getQueryHandleData(
          queryClient,
          postQuery,
          {} as experimental_DefinedQueryHandle<typeof postQuery>,
        ),
      })),
    )
  })

  it("should pass a dependent entry its parent's data and type a nullable result", async () => {
    const { handles, data } = await experimental_loadQueryHandles(
      queryClient,
      (q) => {
        const post = q.wait(postQuery, { id: '1' })
        return {
          post,
          author: q.after(post, (value) => {
            expectTypeOf(value).toEqualTypeOf<Post | null>()
            return value?.authorId
              ? q.wait(userQuery, { id: value.authorId })
              : null
          }),
          comments: q.after(post, () => q.start(viewerQuery)),
        }
      },
    )

    expectTypeOf(handles.author).toEqualTypeOf<experimental_DefinedQueryHandle<
      typeof userQuery
    > | null>()
    expectTypeOf(data.author).toEqualTypeOf<{ name: string } | null>()
    expectTypeOf(handles.comments).toEqualTypeOf<
      experimental_QueryHandle<typeof viewerQuery>
    >()
    expectTypeOf(data).not.toHaveProperty('comments')
  })

  it('should only take an entry that waits as a parent', () => {
    assertType(
      experimental_loadQueryHandles(queryClient, (q) => {
        const viewer = q.start(viewerQuery)
        return {
          // @ts-expect-error a started entry has no data to wait for
          user: q.after(viewer, () => q.start(userQuery, { id: '1' })),
        }
      }),
    )
  })

  it('should give handles that read with the suspense hooks', async () => {
    const { handles } = await experimental_loadQueryHandles(
      queryClient,
      (q) => ({
        post: q.wait(postQuery, { id: '1' }),
        feed: q.start(feedQuery, { size: 10 }),
      }),
    )

    function Page() {
      const post = useSuspenseQuery(
        experimental_fromHandle(postQuery, handles.post),
      )
      const feed = useSuspenseInfiniteQuery(
        experimental_fromHandle(feedQuery, handles.feed),
      )
      expectTypeOf(post.data).toEqualTypeOf<Post | null>()
      expectTypeOf(feed.data).toEqualTypeOf<
        InfiniteData<Array<number>, unknown>
      >()
      return null
    }
    assertType(Page)
  })
})
