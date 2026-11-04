import {
  QueryClient,
  QueryObserver,
  defaultShouldDehydrateQuery,
  dehydrate,
  hydrate,
} from '@tanstack/query-core'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const queryKey = ['post', 1]

// Server: the query is still pending when the page is dehydrated, and rejects later
const serverClient = new QueryClient({
  defaultOptions: {
    dehydrate: {
      // include pending queries in dehydration, as in the Advanced SSR guide
      shouldDehydrateQuery: (query) =>
        defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
    },
  },
})
serverClient
  .query({
    queryKey,
    queryFn: () => sleep(10).then(() => Promise.reject(new Error('server error'))),
    retry: false,
  })
  .catch(() => {})
const dehydratedState = dehydrate(serverClient)

// Browser: the client turns retries off by default, and this reader turns them back on
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
hydrate(queryClient, dehydratedState)

const observer = new QueryObserver(queryClient, {
  queryKey,
  queryFn: () => sleep(10).then(() => 'data from the browser'),
  retry: 1,
  retryDelay: 10,
})
observer.subscribe(() => {})

await sleep(500)
const { status, data, error } = queryClient.getQueryState(queryKey)
console.log({ status, data, error: error?.message })
// Expected: { status: 'success', data: 'data from the browser', error: undefined }
process.exit(0)
