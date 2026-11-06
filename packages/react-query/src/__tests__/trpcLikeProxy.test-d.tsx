import { assertType, describe, expectTypeOf, it } from 'vitest'
import {
  QueryClient,
  experimental_waterfallHandle,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from '..'
import { createOptionsProxy } from './trpcLikeProxy'
import type {
  InfiniteData,
  experimental_InferQueryHandleData,
  experimental_QueryHandle,
} from '..'
import type { OptionsProxy } from './trpcLikeProxy'

type Post = { id: string; title: string; authorId: string }
type Comment = { id: string; text: string }
type FeedPage = { items: Array<string>; nextCursor: number | null }

const router = {
  'post.byId': (_input: { id: string }): Promise<Post> =>
    Promise.resolve({ id: '1', title: '', authorId: 'a' }),
  'post.byAuthor': (_input: { authorId: string }): Promise<Array<Post>> =>
    Promise.resolve([]),
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
  const loadHandles = () =>
    trpc.$loadHandles((load) => ({
      post: load.start(trpc['post.byId'].queryOptions, { id: '1' }),
      waited: load.wait(trpc['post.byId'].queryOptions, { id: '1' }),
      comments: load.start(trpc['post.comments'].queryOptions, {
        postId: '1',
        page: 1,
      }),
      feed: load.wait(
        trpc.feed.infiniteQueryOptions,
        { limit: 2 },
        { pages: 2 },
      ),
    }))

  it("should type the input from the procedure's factory", () => {
    assertType(
      trpc.$loadHandles((load) => ({
        post: load.start(trpc['post.byId'].queryOptions, { id: '1' }),
        // @ts-expect-error the input has the wrong shape
        wrong: load.wait(trpc['post.byId'].queryOptions, { id: 1 }),
        feed: load.wait(trpc.feed.infiniteQueryOptions, {
          limit: 2,
          // @ts-expect-error the infinite factory takes no cursor
          cursor: 1,
        }),
      })),
    )
    // @ts-expect-error a procedure whose output has no cursor has no infinite factory
    assertType(trpc['post.byId'].infiniteQueryOptions)
  })

  it('should type handles and the data of waited procedures', async () => {
    const { handles, data } = await loadHandles()

    expectTypeOf(handles.post).toEqualTypeOf<
      experimental_QueryHandle<TRPC['post.byId']['queryOptions']>
    >()
    expectTypeOf(handles.waited).toEqualTypeOf(handles.post)
    expectTypeOf(handles.post).not.toHaveProperty('data')
    expectTypeOf(handles.post.input).toEqualTypeOf<{ id: string }>()
    expectTypeOf(handles.feed.input).toEqualTypeOf<
      Omit<{ limit: number; cursor?: number | null }, 'cursor'>
    >()
    expectTypeOf(data).toEqualTypeOf<{
      waited: Post
      feed: InfiniteData<FeedPage, unknown>
    }>()
  })

  it('should read any handle without naming its procedure', async () => {
    const { handles } = await loadHandles()

    expectTypeOf(
      useSuspenseQuery(trpc.$fromHandle(handles.post)).data,
    ).toEqualTypeOf<Post>()
    expectTypeOf(useQuery(trpc.$fromHandle(handles.post)).data).toEqualTypeOf<
      Post | undefined
    >()
    expectTypeOf(useQuery(trpc.$fromHandle(handles.waited)).data).toEqualTypeOf<
      Post | undefined
    >()
    expectTypeOf(
      useSuspenseInfiniteQuery(trpc.$fromHandle(handles.feed)).data,
    ).toEqualTypeOf<InfiniteData<FeedPage, unknown>>()
  })

  it('should type select from the procedure when read-site options are spread', async () => {
    const { handles } = await loadHandles()

    const { data } = useSuspenseQuery({
      ...trpc.$fromHandle(handles.post),
      select: (value) => {
        expectTypeOf(value).toEqualTypeOf<Post>()
        return value.title
      },
    })

    expectTypeOf(data).toEqualTypeOf<string>()
  })

  it('should type handle props from the procedure', async () => {
    const { handles } = await loadHandles()
    const props = {} as {
      post: experimental_QueryHandle<TRPC['post.byId']['queryOptions']>
    }

    expectTypeOf(handles.post).toEqualTypeOf(props.post)
    expectTypeOf(
      useSuspenseQuery(trpc.$fromHandle(props.post)).data,
    ).toEqualTypeOf<Post>()
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

  it('should switch a handle with waterfallHandle', async () => {
    const { handles } = await loadHandles()

    const next = experimental_waterfallHandle(
      trpc['post.comments'].queryOptions,
      handles.comments,
      (input) => {
        expectTypeOf(input).toEqualTypeOf<{ postId: string; page: number }>()
        return { ...input, page: 2 }
      },
    )

    expectTypeOf(next).toEqualTypeOf(handles.comments)
    expectTypeOf(useSuspenseQuery(trpc.$fromHandle(next)).data).toEqualTypeOf<
      Array<Comment>
    >()
  })

  it("should infer a procedure's data from its factory, the same as useSuspenseQuery", async () => {
    const { handles } = await loadHandles()

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
  })

  it("should pass a dependent procedure its parent's data", async () => {
    const { handles, data } = await trpc.$loadHandles((load) => {
      const post = load.wait(trpc['post.byId'].queryOptions, { id: '1' })
      return {
        post,
        authorPosts: load.after(post, (value) => {
          expectTypeOf(value).toEqualTypeOf<Post>()
          return load.start(trpc['post.byAuthor'].queryOptions, {
            authorId: value.authorId,
          })
        }),
      }
    })

    expectTypeOf(data).toEqualTypeOf<{ post: Post }>()
    expectTypeOf(
      trpc.$fromHandle(handles.authorPosts).queryKey[0],
    ).toEqualTypeOf<'post.byAuthor'>()
  })
})
