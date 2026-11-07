import { assertType, describe, expectTypeOf, it } from 'vitest'
import {
  QueryClient,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import { createOptionsProxy } from './trpcLikeProxy'
import type {
  InfiniteData,
  experimental_DefinedQueryHandle,
  experimental_InferQueryHandleData,
  experimental_QueryHandle,
} from '..'
import type { OptionsProxy } from './trpcLikeProxy'

type Post = { id: string; title: string }
type Comment = { id: string; text: string }
type FeedPage = { items: Array<string>; nextCursor: number | null }

const router = {
  'post.byId': (_input: { id: string }): Promise<Post> =>
    Promise.resolve({ id: '1', title: '' }),
  'post.comments': (_input: {
    postId: string
    page: number
  }): Promise<Array<Comment>> => Promise.resolve([]),
  feed: (_input: {
    limit: number
    cursor?: number | null
  }): Promise<FeedPage> => Promise.resolve({ items: [], nextCursor: null }),
}

type TRPC = OptionsProxy<typeof router>

const trpc = createOptionsProxy(router, new QueryClient())

describe('a tRPC-like proxy on the public handle APIs', () => {
  it("should type the entries' input from the procedure", () => {
    assertType(trpc['post.byId'].$prefetchEntry({ id: '1' }))
    // @ts-expect-error the input has the wrong shape
    assertType(trpc['post.byId'].$fetchEntry({ id: 1 }))
    // @ts-expect-error the input has the wrong shape
    assertType(trpc['post.byId'].$ensureEntry({ id: 1 }))
    // @ts-expect-error a procedure whose output has no cursor has no infinite entries
    assertType(trpc['post.byId'].$fetchInfiniteEntry)
  })

  it('should give fetch and ensure entries defined handles and data, and keep prefetch handles plain', async () => {
    const [handles, data] = await trpc.$loadHandles({
      post: trpc['post.byId'].$fetchEntry({ id: '1' }),
      ensured: trpc['post.byId'].$ensureEntry({ id: '1' }),
      comments: trpc['post.comments'].$prefetchEntry({ postId: '1', page: 1 }),
      feed: trpc.feed.$fetchInfiniteEntry({ limit: 2 }, { pages: 2 }),
    })

    expectTypeOf(handles.post).toEqualTypeOf<
      experimental_DefinedQueryHandle<TRPC['post.byId']['queryOptions']>
    >()
    expectTypeOf(handles.ensured).toEqualTypeOf(handles.post)
    expectTypeOf(handles.comments).toEqualTypeOf<
      experimental_QueryHandle<TRPC['post.comments']['queryOptions']>
    >()
    expectTypeOf(handles.post.input).toEqualTypeOf<{ id: string }>()
    expectTypeOf(handles.feed.input).toEqualTypeOf<
      Omit<{ limit: number; cursor?: number | null }, 'cursor'>
    >()
    expectTypeOf(data).toEqualTypeOf<{
      post: Post
      ensured: Post
      feed: InfiniteData<FeedPage, unknown>
    }>()
  })

  it('should read any handle without naming its procedure', async () => {
    const [handles] = await trpc.$loadHandles({
      prefetched: trpc['post.byId'].$prefetchEntry({ id: '1' }),
      fetched: trpc['post.byId'].$fetchEntry({ id: '1' }),
      feed: trpc.feed.$prefetchInfiniteEntry({ limit: 2 }),
    })

    expectTypeOf(
      useSuspenseQuery(trpc.$fromHandle(handles.prefetched)).data,
    ).toEqualTypeOf<Post>()
    expectTypeOf(
      useQuery(trpc.$fromHandle(handles.prefetched)).data,
    ).toEqualTypeOf<Post | undefined>()
    expectTypeOf(
      useQuery(trpc.$fromHandle(handles.fetched)).data,
    ).toEqualTypeOf<Post | undefined>()
    expectTypeOf(
      useSuspenseQuery(trpc.$fromHandle(handles.fetched)).data,
    ).toEqualTypeOf<Post>()
    expectTypeOf(
      useSuspenseInfiniteQuery(trpc.$fromHandle(handles.feed)).data,
    ).toEqualTypeOf<InfiniteData<FeedPage, unknown>>()
  })

  it('should type select from the procedure when read-site options are spread', () => {
    const post = {} as experimental_QueryHandle<
      TRPC['post.byId']['queryOptions']
    >

    const { data } = useSuspenseQuery({
      ...trpc.$fromHandle(post),
      select: (value) => {
        expectTypeOf(value).toEqualTypeOf<Post>()
        return value.title
      },
    })

    expectTypeOf(data).toEqualTypeOf<string>()
  })

  it('should not accept handles the router did not start', () => {
    const unknownPath = {
      queryKey: ['nope', { input: { id: '1' }, type: 'query' }],
      input: { id: '1' },
    } as const
    const wrongInput = {
      queryKey: ['post.byId', { input: { id: 1 }, type: 'query' }],
      input: { id: 1 },
    } as const

    // @ts-expect-error the path isn't a procedure of the router
    assertType(trpc.$fromHandle(unknownPath))
    // @ts-expect-error the input doesn't match the procedure's
    assertType(trpc.$fromHandle(wrongInput))
  })

  it("should read a procedure from its options with a handle's input", async () => {
    const [{ comments }] = await trpc.$loadHandles({
      comments: trpc['post.comments'].$prefetchEntry({ postId: '1', page: 1 }),
    })

    expectTypeOf(comments.input).toEqualTypeOf<{
      postId: string
      page: number
    }>()
    expectTypeOf(
      useSuspenseQuery(
        trpc['post.comments'].queryOptions({ ...comments.input, page: 2 }),
      ).data,
    ).toEqualTypeOf(useSuspenseQuery(trpc.$fromHandle(comments)).data)
  })

  it("should infer a procedure's data from its factory, the same as useSuspenseQuery", async () => {
    const [handles] = await trpc.$loadHandles({
      post: trpc['post.byId'].$prefetchEntry({ id: '1' }),
      feed: trpc.feed.$fetchInfiniteEntry({ limit: 2 }),
    })

    expectTypeOf<
      experimental_InferQueryHandleData<TRPC['post.byId']['queryOptions']>
    >().toEqualTypeOf<Post>()
    expectTypeOf<
      experimental_InferQueryHandleData<TRPC['post.byId']['queryOptions']>
    >().toEqualTypeOf(useSuspenseQuery(trpc.$fromHandle(handles.post)).data)
    expectTypeOf<
      experimental_InferQueryHandleData<typeof handles.post>
    >().toEqualTypeOf<Post>()
    expectTypeOf<
      experimental_InferQueryHandleData<TRPC['feed']['infiniteQueryOptions']>
    >().toEqualTypeOf(
      useSuspenseInfiniteQuery(trpc.$fromHandle(handles.feed)).data,
    )
    expectTypeOf<
      experimental_InferQueryHandleData<typeof handles.feed>
    >().toEqualTypeOf<InfiniteData<FeedPage, unknown>>()
  })
})
